# Sync delivery stop-loss implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent transport failures, malformed responses, command replays, and partial ACK results from being recorded as successful edge/cloud synchronization.

**Architecture:** Keep REST as the only cloud-to-edge command path and preserve edge authority. The scheduled outbox, bootstrap, and command-ACK consumers will require explicit protocol success before advancing durable state. Every pending command passes through the shared command ledger before validation or mutation; permanent validation failures are queued as durable terminal ACKs. The frozen boot-DDL node keeps the same trigger definitions, but executes their legacy replacement as one atomic safety operation and enters a process-lifetime write gate when the resulting inventory is unsafe.

**Tech Stack:** Node-RED function nodes, `osi-db-helper`, `osi-command-ledger`, SQLite, Node.js 22 `node:test`, JSON flow mutation scripts, GitHub Actions.

## Global constraints

- Implement this plan before the writer rollout or any refactor-boundary deployment. It stops permanent sync loss while later repairs are in progress.
- Under `2026-07-15-refactor-repair-program.md`, use this plan's Kaba100 steps as checks inside the single Train A deployment, not as a separate deploy or restart.
- In that program mode, export `OSI_REPAIR_PROGRAM_MODE=1` and do not stage OSI OS `AGENTS.md` in a source-slice commit. Record the reviewed invariant fragment in the execution report; the program orchestrator owns the single integrated A1 documentation checkpoint.
- Work from current `main`; confirm `HEAD == origin/main` before implementation.
- Base implementation on `origin/main` containing merged [OSI OS PR #146](https://github.com/Open-Smart-Irrigation/osi-os/pull/146), merge commit `f50950b1767a1aa6302ef2553d68a4e379b5b142` or a verified descendant. Preserve its fail-closed `/var/run/osi-identity-restart.json` reader ahead of `sync-bootstrap-build`, `sync-outbox-build`, `sync-pending-build`, `sync-force-build`, `command-ack-build-batch`, `sync-state-build`, and `al-link-build-req`; the reader runs before `DEVICE_EUI*`, capability state, gateway-migration preflight, mutation, or transport. Missing sentinel permits evaluation only when `fs` is available; present, malformed, unreadable, or unavailable-`fs` state blocks. Transport identity comes only from the boot-time `DEVICE_EUI*` snapshot after sentinel absence, never from the identity cache, sentinel target, completion marker, or request queue. Preserve coordinated link/unlink restart requests, filtered GUI status, exact node `libs`, protected preflight bodies/hashes, and all merged identity tests/flow-size allowance entries. Extend those nodes and tests; do not replace their reader or weaken it during protocol-capability integration.
- Do not change the command/event/resource JSON Schemas, measurement canonicalization formulas, or edge-authority rules. The reviewed exception is an additive, versioned v3 pending-command/ACK HTTP contract; existing v2 endpoints and bytes remain isolated compatibility paths until a separately authorized fleet retirement.
- Do not add a cloud-to-edge MQTT path.
- Do not add a table, column, index, trigger definition, or other schema behavior. The v3 non-downgrade fact lives in the fsynced append-only `/data/osi-sync/protocol-capabilities/` generation chain owned below, not SQLite or Node-RED context storage. Atomic execution and the fail-stop write gate are a sanctioned safety correction to the existing frozen trigger loop, not permission for further boot DDL. Record this narrow exception in the schema-ownership ADR and `AGENTS.md` in the same commit.
- Edit `flows.json` with a guarded parse-mutate-serialize script and mirror bcm2712 to bcm2709 byte-for-byte.
- The `scripts/verify-flows-size-ratchet-allowances.json` edits in this plan target the absolute `max_chars`/`max_total` schema created by repair-program Task A0. At the pinned base the file still holds base-relative deltas, so standalone execution outside the program must land A0's ratchet-format migration first (or an equivalent reviewed migration) before changing any ceiling.
- Preserve command IDs, effect keys, terminal result names, retry metadata, and independent per-entry `accepted`/`terminal` fields on v3. Never infer v3 capability from an ordinary v2 response.
- Do not access `osicloud.ch`. Kaba100 and the test server are the only live verification targets, and only after local gates pass.
- Never overwrite `/data/db/farming.db`; take the live-ops backup before the Kaba100 rehearsal.
- A missing status, status `0`, malformed body, missing result entry, or unrecognized per-entry status is retryable. None may advance `delivered_at`, `last_full_backfill_at`, or gateway-migration state. The legacy v2 command-ACK path keeps its existing behavior only behind explicit protocol isolation; these stop-loss acceptance rules apply to v3.

---

## Confirmed failures

`sync-outbox-http` converts a transport exception to `statusCode=0`. `sync-outbox-mark` checks `if (msg.statusCode && ...)`, so zero bypasses the failure branch. When the failure payload has no result array, the node falls back to every `_syncEventId` and marks the batch delivered. A temporary network failure therefore becomes permanent mirror loss.

`sync-bootstrap-http` uses the same transport representation and `sync-bootstrap-mark` uses the same truthy predicate. Status zero writes `sync_cursor.last_full_backfill_at`, records `lastBootstrapSuccessAt`, clears `gatewayMigrationPendingBootstrap`, and resumes incremental delivery even though the server accepted nothing.

`command-ack-mark-delivered` treats every HTTP 2xx as full-batch success. The server deliberately returns 200 with per-entry results such as `LEASE_MISMATCH` and `terminal=false`; the current edge marks those ACK rows delivered and never retries them.

`WORK_REQUEST_STATUS` leaves `sync-pending-split` on a dedicated wire to `work-request-status-apply`, bypassing `osi-command-ledger`. Replaying one command ID with altered payload mutates the local request twice. Other permanent validation failures are dropped in `reject-indefinite-open` before a durable rejection ACK exists, so the cloud retries a command the edge has already decided will never be accepted.

The boot trigger loop catches each `DROP TRIGGER` or `CREATE TRIGGER` failure, warns, and continues to `sync ready`. A failure after a drop can leave the database without an outbox trigger while the runtime advertises readiness.

## File map

| File | Responsibility after this plan |
|---|---|
| `scripts/test-sync-delivery-fail-closed.js` | Executes the shipped flow functions against controlled DB and flow-context facades, including status-zero and mixed-result cases. |
| `scripts/test-flows-wiring.js` | Pins dedupe-before-validation ordering and the `WORK_REQUEST_STATUS` route through the ledger. |
| `scripts/verify-sync-flow.js` | Pins explicit HTTP success predicates, bootstrap `success === true`, per-entry ACK handling, and trigger readiness inventory. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | Fail-closed delivery consumers, deduplicated pending commands, durable validation NACKs, and trigger postcondition check. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` | Byte-identical maintained-profile mirror. |
| Maintained `osi-command-ledger/index.js` copies and tests | Own token-free domain outcomes, protected ledger context, crash-safe effect state, immutable token-generation ACK bytes, and the mandatory pre-mutation command-activity witness call. |
| Maintained `osi-db-helper/index.js` copies and tests | Add the serialized FULL-synchronous intent transaction before an external effect and retain the Task 5 fail-stop facade. |
| Maintained `osi-sync-protocol-state/` copies and `osi-lib` registry/tests | Own initialized persistent negotiation identity, monotonic v3 pinning, explicit reset epochs, factory-zero bootstrap, the independent append-only command-activity witness, purpose-specific disposition restore, general database-restore invalidation/reconciliation, and the only function-node load path. |
| `scripts/sync-protocol-capability-cli.js`, both-profile ROM-bound copies, and tests | Initialize/status/reset the file state, establish a provenance-bound factory-zero CLEAR, prepare disposition restore, and bracket any general database replacement through the same parser/lock/CAS with stopped-writer and backup/audit gates. |
| A0-created `scripts/audit-command-ack-state.js`, both-profile ROM copies, and `scripts/reconcile-command-ack-state.js` | Extend the factory-zero audit into complete transport/outcome/reference classification; under stopped writers, atomically rebind complete same-origin historical v2 state, publish a blocking historical quarantine, quarantine/delete exact active old-identity transports for an authorized reset, or merge a reviewed database-restore snapshot without executing effects or sending ACKs. |
| `scripts/audit-farming-database-state.js` and test | Produce a stable canonical schema/per-table/full logical hash over every farming database table so a whole-DB restore cannot silently erase sensor, sync, journal, local API, or other canonical writes. |
| Train A artifact builder/verifier, `backup-pre-deploy.sh`, and `deploy.sh` | Carry the capability CLI/helper closure, evidence-back state without rollback, and initialize it only after arm plus stopped-state proof. |
| `.github/workflows/verify-sync-flow.yml` | Runs the executable stop-loss suite in CI. |
| `scripts/verify-live-gateway-identity.js` | Retains the seven exact identity gates, protected bodies/libs, and identity allowance reasons/owned-node membership; absolute sizes remain owned by the general ratchet. |
| `docs/contracts/sync-schema/README.md` | Records that HTTP success alone does not imply per-entry ACK acceptance and that acceptance is distinct from command terminality. |
| `AGENTS.md` | Durable fail-closed delivery and dedupe-before-mutation invariants. |

### Task 1: Reproduce every fail-open path with shipped function text

**Files:**

- Create: `scripts/test-sync-delivery-fail-closed.js`

**Interfaces:**

- Produces: `executeFlowFunction(nodeId, msg, options) -> Promise<{ result, sql, flowState, errors }>`.
- Produces: CLI `--section delivery|ack|commands|all`, defaulting to `all` and rejecting unknown sections.
- Produces: a fake `osiDb.Database` supporting callback-style `all`, `run`, and `close` without `prepare`.
- Produces: regression cases that fail on current `main` and execute the actual `func` strings from canonical `flows.json`.

- [ ] **Step 1: Build the execution harness**

Load canonical `flows.json`, locate nodes by stable ID, and compile their function text with only the variables the node declares in `libs` or receives from Node-RED:

```js
function compile(nodeId, names) {
  const node = flows.find((candidate) => candidate.id === nodeId);
  assert.ok(node && node.type === 'function', `missing function node ${nodeId}`);
  return new Function(...names, node.func);
}
```

The fake database records SQL plus parameters and applies enough state to distinguish `delivered_at`, retry increments, cursor writes, improvement-request updates, applied-command rows, and ACK-outbox rows. It must throw on `.prepare` access so tests cannot drift toward the wrong runtime contract.

- [ ] **Step 2: Add status-zero outbox and bootstrap tests**

Execute `sync-outbox-mark` with `_syncEventIds=['event-a','event-b']`, `statusCode=0`, and the real transport-failure payload shape. Assert no SQL contains `SET delivered_at`, both event IDs remain pending, and `lastOutboxDeliverySuccessAt` is unchanged.

Execute `sync-bootstrap-mark` with status zero and initial flow state:

```js
{
  gatewayMigrationPendingBootstrap: true,
  gatewayMigrationPaused: true,
  gatewayMigrationPreviousGatewayDeviceEuis: ['0011223344556677'],
  gatewayMigrationLastTo: 'AABBCCDDEEFF0011'
}
```

Assert no `sync_cursor` write occurs, the two migration booleans remain true, and no `lastBootstrapSuccessAt` or `bootstrapped` result is recorded. Repeat for missing status, HTTP 500, and HTTP 200 with `{ success:false }`.

- [ ] **Step 3: Add explicit success controls**

For the outbox, use HTTP 200 with one `APPLIED`, one `RETRYABLE_ERROR`, and one unknown result. Require only the applied event to receive `delivered_at`; the other two receive retry metadata. Add duplicate-identical and duplicate-conflicting results for one requested `eventUuid`; in both cases that requested event remains pending and receives bounded protocol-error retry metadata. Add an unrequested result identity and require it to be reported as a protocol error without changing any unrelated row. For bootstrap, require HTTP 200 and `{ success:true, applied:3, skipped:0, gatewayMigration:{...} }` before the cursor and migration state advance.

- [ ] **Step 4: Add mixed command-ACK tests**

Build two queued ACK entries whose outbox row IDs differ from their command IDs. Return HTTP 200 with:

```js
{
  results: [
    { commandId: 701, status: 'ACKED', accepted: true, terminal: true },
    { commandId: 702, status: 'LEASE_MISMATCH', accepted: false, terminal: false }
  ]
}
```

Require only command 701's outbox row to receive `delivered_at`. Command 702 must increment `retry_count` and retain a bounded `last_error`. Add missing-result, duplicate-result, malformed-body, status-zero, and HTTP-500 cases; all unresolved entries remain pending.

Then create two local outbox rows with the same `commandId`, lease token, and canonically identical ACK payloads. Require one outgoing ACK object, correlation metadata with both local outbox IDs, and one unique accepted server result to deliver both rows. Repeat with a conflicting token and with conflicting status/detail payloads; require no ACK for that identity, both rows pending with `protocol_local_ack_conflict:<id>`, and a bounded warning without token or payload. This covers the shipped non-unique `command_ack_outbox.command_id` surface rather than assuming local command IDs are unique.

- [ ] **Step 5: Add replay and durable-rejection tests**

Execute the pending-command wiring with command ID `801` and a `WORK_REQUEST_STATUS` payload that sets request `req-1` to `ACCEPTED`. Replay ID `801` with `REJECTED`. Require one `improvement_requests` update and an exact replay of the first terminal ACK.

Run the same valid-looking pending-command body with `statusCode=0`, missing status, string `'200'`, and HTTP 500. None may update `lastPendingCommandPollSuccessAt`, clear the pending-command error state, emit a command, reach dedupe, or mutate a domain row. Integer HTTP 200 is the positive control.

Run `OPEN`, an unknown command type, and `OPEN_FOR_DURATION` without a duration. Each first delivery must create one `applied_commands` terminal row and one pending `command_ack_outbox` row with `REJECTED_PERMANENT`. Replaying the same ID must not reach a mutation/downlink output and must reproduce the stored reason.

- [ ] **Step 6: Run the suite and capture the red evidence**

```bash
node scripts/test-sync-delivery-fail-closed.js
```

Expected on current `main`: failures showing outbox delivery on status zero, bootstrap success on status zero, lease-mismatched ACK delivery, repeated work-request mutation, and missing durable validation ACKs.

- [ ] **Step 7: Preserve red evidence without creating a broken commit**

Record the failing cases and command output in the execution report or review notes. Keep the test uncommitted until Task 4 makes every section green, and do not add a failing CI step or push a deliberately red commit. The section switch allows Tasks 2 and 3 to verify their own subset while the later expected failures remain red.

### Task 2: Make scheduled outbox and bootstrap delivery explicit

**Files:**

- Carry forward from Task 1: `scripts/test-sync-delivery-fail-closed.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`
- Modify/Test: `scripts/verify-live-gateway-identity.js`
- Modify: `scripts/test-flows-wiring.js`

**Interfaces:**

- Produces: `isHttpSuccess(statusCode)`, local to each touched consumer, true only for integer 200–299.
- Produces: scheduled outbox behavior with no whole-batch fallback when the v2 result array is absent.
- Produces: bootstrap success requiring `payload.success === true`.

- [ ] **Step 1: Replace truthy status predicates**

In both consumers use the same literal predicate so the verifier can pin it:

```js
function isHttpSuccess(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;
}
```

For any non-success, preserve durable pending state and set `sync_state.lastError` with `statusCode: Number.isInteger(msg.statusCode) ? msg.statusCode : null`. Never call it a delivery success.

- [ ] **Step 2: Remove scheduled outbox whole-batch fallback**

Require `payload.results` or the compatibility alias `payload.eventResults` to be an array. If it is absent or empty while `_syncEventIds` is nonempty, classify every requested event as retryable and store `protocol_response_missing_results` as the error. Do not initialize `deliveredIds` from `_syncEventIds`.

```js
let deliveredIds = [];
let retryableIds = [];
if (!Array.isArray(eventResults)) {
  retryableIds = msg._syncEventIds.map(String);
} else {
  // Preserve APPLIED/DUPLICATE, REJECTED, and retryable result classification.
}
```

Normalize the requested event IDs once, group normalized result objects by `eventUuid`, and classify a requested event only when exactly one well-formed result exists for that ID. Zero matches, duplicate-identical matches, duplicate-conflicting matches, and malformed matches keep the requested event pending and set bounded retry metadata such as `protocol_response_missing_result:<id>`, `protocol_response_duplicate_result:<id>`, or `protocol_response_malformed_result:<id>`. An unrequested result identity never updates a row; store a bounded `protocol_response_unrequested_result:<id>` in `sync_state.lastError` without logging or storing the response body. Do not allow an ID with duplicate results to enter any delivered, rejected, or retryable group derived from the individual result values.

Only a unique `APPLIED` or `DUPLICATE` result sets `delivered_at`; only a unique existing explicit `REJECTED` result sets `rejected_at`. A unique known retryable result remains pending with its bounded retry metadata. Perform one final disjointness assertion before constructing SQL so no requested ID can occur in more than one terminal or retry group. Update `lastOutboxDeliverySuccessAt` only when at least one requested entry received a unique terminal `APPLIED`, `DUPLICATE`, or `REJECTED` result. A 2xx response containing only missing, malformed, duplicate, unrequested, unknown, or retryable results does not advance that timestamp. Clear `sync_state.lastError` only when every requested entry has one known result, there are no unrequested/malformed/duplicate identities, and all protocol work is accounted for; otherwise retain the bounded protocol error. Add timestamp/error-state assertions for malformed-only, duplicate-only, unrequested-only, retryable-only, mixed terminal/protocol-error, and all-terminal responses.

- [ ] **Step 3: Require the bootstrap success marker**

Before opening the database:

```js
const payload = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)
  ? msg.payload
  : null;
if (!isHttpSuccess(msg.statusCode) || !payload || payload.success !== true) {
  setSyncState({ lastError: bootstrapFailure(msg, payload) });
  return null;
}
```

Only this branch may write `last_full_backfill_at`, rotate the sync token, set `lastBootstrapSuccessAt`, or clear gateway-migration pause flags.

- [ ] **Step 4: Add structural pins and run focused tests**

Require both nodes to contain `Number.isInteger(statusCode)`, require bootstrap to contain `payload.success !== true`, and forbid `let deliveredIds = msg._syncEventIds`. Then run:

```bash
node scripts/test-sync-delivery-fail-closed.js --section delivery
node scripts/verify-sync-flow.js
```

- [ ] **Step 5: Mirror and checkpoint the green subset**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
node scripts/test-sync-delivery-fail-closed.js --section delivery
node scripts/verify-profile-parity.js
```

Keep these flow changes uncommitted until the activation slice. The shipped executable remains intentionally red in the ACK/command sections while the three dormant green checkpoints are built; Task 4's activation commit supplies the complete caller wiring and is the first deployable SHA.

### Task 3: Honor per-entry command-ACK results

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`
- Test: `scripts/test-sync-delivery-fail-closed.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/index.test.js`
- Modify: both profiles' `files/usr/share/node-red/osi-journal/commands.js`, `lifecycle.js`, and `api.js`
- Modify/Test: `scripts/test-journal-command-path.js`, `scripts/test-journal-lifecycle.js`, and `scripts/test-journal-api.js`
- Create: `scripts/verify-command-ledger-consumers.js`
- Create: `scripts/verify-command-ledger-consumers.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.test.js`
- Modify/Extend: A0-created `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state/` factory-capable helper and tests
- Modify/Extend: byte-identical bcm2709 `osi-sync-protocol-state` mirror
- Create/Test: `scripts/verify-command-activity-witness.js`; pin every command/effect/ACK mutation producer and its mandatory witness-before-mutation edge
- Modify: both profiles' `files/usr/share/node-red/package.json` and `package-lock.json`
- Modify: both profiles' `files/etc/uci-defaults/98_osi_node_red_seed`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js`
- Modify: byte-identical bcm2709 `osi-lib` mirror
- Modify/Extend: A0-created `scripts/audit-command-ack-state.js` and test
- Modify/Verify: both profiles' `files/usr/libexec/osi-audit-command-ack-state.js`
- Create: `scripts/reconcile-command-ack-state.js`
- Create: `scripts/reconcile-command-ack-state.test.js`
- Create: `scripts/audit-farming-database-state.js`
- Create: `scripts/seal-database-restore-baseline.js`
- Create: `scripts/database-integrity-recovery.js`
- Create: `scripts/manifests/database-restore-reverse-adapters.json`
- Create: `scripts/manifests/database-recovery-implementations.json`
- Create: `scripts/trust/database-integrity/<manifest-enumerated-key-id>.ed25519.pub`
- Create: `scripts/manifests/database-integrity-source-trust-roots.json`
- Create: `scripts/audit-farming-database-state.test.js`
- Create: `scripts/seal-database-restore-baseline.test.js`
- Create: `scripts/database-integrity-recovery.test.js`
- Modify/Extend: A0-created `scripts/sync-protocol-capability-cli.js` and test
- Modify/Verify: both profiles' `files/usr/libexec/osi-sync-protocol-capability-cli.js`
- Modify/Test: `scripts/generate-factory-image-provenance.js` and its pure codec/test to refresh the complete factory trust bundle while preserving reviewed image build IDs
- Modify/Verify: both profiles' `files/usr/libexec/osi-factory-image-provenance.js` and `osi-factory-image-provenance-cli.js`
- Modify/Verify: both profiles' `files/usr/share/osi-deploy/image-guard-manifest.json` and `factory-image-provenance.json`
- Modify/Test: `scripts/verify-factory-image-provenance.js`, `scripts/verify-built-factory-image-provenance.js`, `scripts/verify-profile-parity.js`, and their direct tests
- Modify/Test: `scripts/test-image-guard-bootstrap.sh` and `scripts/test-ci-guard-wiring.js`
- Modify: `scripts/lib/deployment-state.js`
- Modify/Test: `scripts/deployment-state-cli.js`
- Modify/Test: `scripts/deployment-state-cli.test.js`
- Modify/Verify: both profiles' `files/usr/libexec/osi-deployment-state.js` and `osi-deployment-state-cli.js`
- Modify/Extend: `scripts/build-train-a-deployment-artifact.js`
- Modify/Extend: `scripts/build-train-a-deployment-artifact.test.js`
- Modify/Extend: `scripts/verify-train-a-deployment-artifact.js`
- Modify/Extend: `scripts/verify-train-a-deployment-artifact.test.js`
- Modify: `scripts/pi/backup-pre-deploy.sh`
- Modify: `scripts/pi/backup-pre-deploy.test.sh`
- Modify: `scripts/pi/restore-pre-deploy.sh`
- Modify: `scripts/pi/restore-pre-deploy.test.sh`
- Modify: `deploy.sh`
- Modify/Test: `scripts/test-deploy-sh.sh`
- Modify/Test: `scripts/test-deploy-atomic-payload-wiring.js`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify: `scripts/test-ci-guard-wiring.js`
- Modify/Test: `scripts/verify-helper-registration.js`
- Modify/Test: `scripts/verify-helper-registration.test.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces:**

- Replaces: `_commandAckIds: number[]` with `_commandAckEntries: Array<{ outboxIds: number[], commandId: number, protocol: 2|3, leaseToken: string|null, canonicalAck: string }>`.
- Produces: v3 ACK transport acceptance by command ID and lease token, independent of command lifecycle terminality and the local outbox row ID.
- Produces: one outgoing ACK per command identity/protocol/token generation only when every local row for that transport generation has byte-identical canonical ACK payload; v2 and v3 transport rows are never mixed, while the token-free cloud command outcome key is stable across a same-identity v2→v3 upgrade.
- Produces: `protocolState.initialize()`, `protocolState.initializeFactoryZero(authority)`, `protocolState.load(identity)`, `protocolState.runWitnessedOperation(descriptor, adapterArgs)`, `protocolState.loadCommandActivityWitness()`, `protocolState.recordHistoricalV2Disposition(identity, receipt)`, `protocolState.prepareDispositionRestore(recovery)`, `protocolState.invalidateHistoricalV2Disposition(identity, restoreReceipt)`, `protocolState.prepareDatabaseRestore(recovery)`, `protocolState.completeDatabaseRestoreReconciliation(recovery)`, `protocolState.prepareIntegrityRecovery(recovery)`, `protocolState.completeIntegrityRecovery(recovery)`, `protocolState.recordNegotiation(identity, result)`, and `protocolState.authorizeReset(transition, confirmation)`, backed only by verified append-only chains under persistent `/data`; no raw activity append or reusable mutation permit is exported.
- Produces: `db.durableTransaction(work)`, a serialized pre-external-effect intent barrier that reads and validates the exact current SQLite `synchronous` mode, temporarily selects `FULL`, begins, commits or rolls back, restores that exact saved mode, and rejects new work until restoration succeeds.
- Produces: `osiCommandLedger.persistExternalIntent(db, context, descriptor)`, `queueExternalIntentRetry(db, retry)`, and `completeIdempotentExternalEffect(db, completion)`, the only external-effect intent/retry/completion APIs used by command producers.

Implement Tasks 3 and 4 as four green, independently reviewed commits; the later detailed steps allocate behavior to these slices and may not collapse them:

1. `feat: add dormant sync protocol foundations` extends the A0 protocol helper with activity SQLite/checkpoint/head-witness codecs, hot-journal recovery, factory immutable anchor, strict current-state readers, command and whole-database audit codecs/CLIs, selected-profile copies, artifact entries, provenance refresh, and direct fault/capacity tests. It changes no flow producer, polling route, or deploy activation path.
2. `refactor: add witnessed command operation adapters` adds `runWitnessedOperation`, the private one-use capability, closed adapter registry, DB/external/ACK adapters, local-principal hashing, coverage verifier, and exhaustive direct tests. No shipped flow calls the new adapters yet, so live behavior remains the prior path.
3. `feat: add dormant database restore reconciliation` adds sealed expected-mutation baselines, exact general and integrity preparation/evidence/result/receipt codecs, whole-DB delta classification, snapshot/reverse-merge and forensic adapters, both capability invalidation/reconciliation verb pairs, deployment recovery phases, artifact/ROM closure, provenance refresh, and crash tests. `deploy.sh`, restore shell, startup, and controller contain explicit assertions that these verbs are unreachable in this commit; remove-one tests prove no implicit/general restore path can call them.
4. `fix: activate fail-closed sync delivery` atomically wires every inventoried producer/ACK response through the witnessed registry, enables deployment initialization/disposition plus general and integrity restore callers, adds v3 pinning plus both-CLEAR/activity startup gates to scheduled and force entry points, mirrors flows, refreshes final artifacts/anchors, and makes the full direct CI union required. Only this commit is eligible for the integrated Train A deployment. A tag, image, live deploy, or downstream repair rebase on commits 1–3 is forbidden; the execution report records their SHAs as non-deployable additive checkpoints and the activation commit as the first deployable SHA.

Each commit runs its focused direct tests, profile/source-resident parity, empty-working-directory artifact checks, provenance `--check`, and negative controls before commit. Commit 4 reruns the union of all four slices. If a source/resident trust-bound byte changes in more than one slice, that slice refreshes and stages all four anchors; later slices never rely on dirty prior output.

- [ ] **Step 0: Add a non-downgradable v3 capability boundary**

Keep the existing v2 pending-command and ACK endpoints unchanged for old servers and fleet gateways. Add a separate v3 pending path and v3 ACK path defined by the cross-repository plan. The edge probes v3 first. Only HTTP 200 with exact `X-OSI-Sync-Protocol: 3`, a strict v3 body, and token-complete commands enables v3 for that normalized server origin; 404 before any successful v3 observation may use the isolated legacy v2 path.

Persist negotiation through `osi-sync-protocol-state`, loaded with `osiLib.require('sync-protocol-state')`, before any command reaches a producer. Do not use `flow`, `global`, Node-RED context storage, UCI, or an environment variable as authority. `scripts/sync-protocol-capability-cli.js` exposes only `initialize-factory-zero`, `initialize`, `status`, `record-v2-disposition`, `prepare-disposition-restore`, `invalidate-v2-disposition`, `prepare-database-restore`, `complete-database-restore-reconciliation`, `prepare-integrity-recovery`, `complete-integrity-recovery`, and `authorize-reset`, and delegates parsing, identity normalization, locking, and CAS to that same helper. The factory and restore verbs have exact deployment-state authorities described below; none is callable by the Node-RED runtime.

Register exactly `'sync-protocol-state': 'osi-sync-protocol-state'` in the canonical `osi-lib` map and its sorted-name test, then mirror it. The function node declares only the existing `osiLib` external module binding; it never adds a bare helper `require()` or a second Node-RED `libs` entry.

Register the helper on every shipping surface required by `scripts/verify-helper-registration.js`: add exact file dependency `"osi-sync-protocol-state": "file:osi-sync-protocol-state"` to each profile root `package.json`, matching the repository's existing local-package convention, regenerate and verify the lock entry without lifecycle scripts, add the helper to each `98_osi_node_red_seed` copy/install loop, and make `deploy.sh` fetch it only from the verified artifact. The profiles remain byte-identical. Extend `scripts/verify-helper-registration.test.js` with delete-one controls across `osi-lib`, dependency, lock, seed, artifact-builder/verifier, and deploy surfaces. Run both `node scripts/verify-helper-registration.js` and `node --test scripts/verify-helper-registration.test.js` directly in the required workflow and pin both exact commands in `scripts/test-ci-guard-wiring.js`; a source-only helper directory or unchanged negative suite cannot pass.

The deployment coordinator runs `initialize` with writers stopped, exact parent phase `protocol-initializing`, and a fsynced operation before the first Node-RED start. The other initializers are the ROM-provenance-bound `initialize-factory-zero` path while the parent is the exact second-boot `image-baseline-initializing/baseline-completing` prefix, and the explicit-authority legacy integrity-recovery branch when a latched missing/corrupt database has a journal-proven all-root absence fact. All run with every application writer inhibited and use the same helper and exclusively create `/data/osi-sync/protocol-capabilities/generations/`, `/reset-receipts/`, `/v2-disposition-receipts/`, `/database-restore-receipts/`, genesis `generations/0000000000000000.json`, the independent monotonic capability witness root `/data/osi-sync-witness/protocol-capability-witnesses/`, `/data/osi-sync-witness/command-activity-witnesses/activity.sqlite`, and the independent current-head/checkpoint root `/data/osi-sync-witness/command-activity-head-witnesses/`; they fsync each before publishing heads. All witness directories are separate no-symlink mode-0700 directories owned by the Node-RED service identity, not children of root-only `/data/osi-deploy`; capability/activity files are mode 0600. Every CLI `--activity-witness-root /data/osi-sync-witness/command-activity-witnesses` deterministically requires that exact sibling head-witness root; no caller can redirect or co-locate it. Capability genesis is `{format:1,generation:0,previousGeneration:null,previousSha256:null,operationId,kind:'GENESIS',createdAt,state:{activeIdentitySha256:null,mode:'UNNEGOTIATED',historicalV2Disposition:'UNASSESSED',historicalV2DispositionReceiptSha256:null,databaseRestore:{status:'CLEAR',restoreEpoch:0}}}`; capability `head.json` is exactly `{format:1,generation:0,generationSha256,witnessSha256}`. Capability witness `0000000000000000.json` is exact `{format:1,generation:0,generationSha256,previousWitnessSha256:null,operationId}`.

The activity database is a dedicated bounded-schema SQLite ledger, never the farming database. It fixes `journal_mode=DELETE`, `synchronous=FULL`, `auto_vacuum=INCREMENTAL`, and `foreign_keys=ON`; has only `activity_chain(generation INTEGER PRIMARY KEY, previous_generation INTEGER, previous_sha256 TEXT, operation_id TEXT UNIQUE, kind TEXT, created_at TEXT, principal_kind TEXT, principal_sha256 TEXT, command_key_sha256 TEXT, adapter_id TEXT, activity_sha256 TEXT, entry_sha256 TEXT)`, singleton `activity_head(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER, entry_sha256 TEXT, checkpoint_generation INTEGER, checkpoint_sha256 TEXT, segment_count INTEGER, segment_accumulator_sha256 TEXT)`, and fixed metadata; rejects triggers/views/extra schema objects; and verifies canonical row hashes. Genesis generation 0 has principal kind `system`, a factory/deployment principal hash, null command/adapter fields, and kind `GENESIS`. `principal_kind` is exactly `cloud|local|system`: cloud hashes the protected capability identity, local hashes canonical `local:<authenticated-actor-uuid|system>:<producer-id>` without storing the actor, and system is initialization only. Unlinked operator/API, local valve, scheduler, and journal mutations use the local form and cannot omit the witness.

Initialization creates the database at an absent temp path, inserts genesis/head in one FULL-synchronous transaction, closes it, verifies schema/quick-check/logical chain, atomically renames it into the absent final path, and fsyncs the file and parent. It then O_EXCL-writes `command-activity-head-witnesses/checkpoints/0000000000000000.json` as exact `{format:1,checkpointGeneration:0,entrySha256,previousCheckpointSha256:null,cumulativeSha256,createdAt}` and atomically publishes `command-activity-head-witnesses/head.json` as exact `{format:1,generation:0,entrySha256,checkpointGeneration:0,checkpointSha256}`. The immutable factory anchor is exactly `{generation:0,entrySha256:<canonical genesis entry hash>}`; `factoryCommandActivityAnchorSha256` hashes those canonical bytes and never hashes mutable `activity_head` or external `head.json` bytes. No path overwrites an existing chain or witness. Runtime code cannot initialize. A partial root set can never take the integrity initialization branch. A backup's historical pre-initialization absence is valid only as the input to the deployment operation. Factory absence is valid only from the provenance-bound first-boot capability, capability-witness, activity-database, and activity-head-witness absence prefix. Integrity-recovery absence is valid only from an existing-gateway backup/evidence fact captured before the latch, exact all-four-root absence, the explicit recovery authority, and a trusted database backup; it initializes genesis with historical disposition `UNASSESSED`, then immediately appends integrity invalidation before any SQLite-set mutation. A crash after the immutable deployment/factory intent but before the first root entry may resume only that exact operation from all-absent roots; once any root/genesis entry exists, missing its peer or returning to absence is corruption and blocks both v3 and v2 command polling.

No function node or producer receives a raw append API or reusable head. `osi-command-ledger` exposes only `runWitnessedOperation(db, {adapterId,kind,principal,commandKeySha256,activitySha256}, args)`. A closed registry maps each `adapterId` to exactly one SQLite transaction, external-effect attempt, or ACK-transport mutation adapter. The wrapper canonicalizes the protected descriptor, appends the activity intent, then creates a process-private nonserializable one-use capability containing the operation ID, adapter ID, activity hash, and generation. Only the registered adapter can consume it, and it must consume it exactly once before its first mutation/effect. Wrong adapter/hash/operation, cached capability, double use, nested operation, caller callback substitution, append-only-without-adapter-completion, or adapter completion without consumption fails. Append-without-work leaves conservative activity evidence but returns failure and grants no second attempt from the same operation ID.

Before any command acceptance, ledger/outbox/retry/reference mutation, external-effect attempt, ACK delivery-state update, or command-driven domain write, that wrapper durably commits one command-activity row. Each logical entry is exactly `{generation,previousGeneration,previousSha256,operationId,kind:'COMMAND_LIFECYCLE_MUTATION'|'EXTERNAL_EFFECT_ATTEMPT'|'ACK_TRANSPORT_MUTATION',createdAt,principalKind:'cloud'|'local',principalSha256,commandKeySha256,adapterId,activitySha256,entrySha256}`; it contains no token, raw payload, credential, actor identifier, device secret, or result detail. The helper takes `BEGIN IMMEDIATE`, revalidates the singleton head and fixed schema, inserts the next safe-integer generation, updates the singleton head and rolling segment accumulator, commits under `synchronous=FULL`, closes, and rereads the committed row/head before returning. The audit response path that marks or removes delivered ACKs uses the registered ACK adapter. `scripts/verify-command-activity-witness.js` inventories every ledger API, direct SQL consumer, effect adapter, local-command/API path, and ACK response handler and rejects an unregistered mutation or any edge outside `runWitnessedOperation`; runtime tests prove the private capability cannot be forged or reused.

After the activity SQLite commit, the helper atomically updates the independent activity-head witness. The database may be exactly one generation ahead of external `head.json` after a crash; under the stable activity lock, the helper recomputes that one row, verifies its predecessor equals the external head, and publishes only that deterministic next head before any command work. Any larger gap, external head ahead, hash mismatch, or database rollback below the external generation blocks. Rolling the activity database back to a factory/deployment anchor while the independent current-head witness is newer is therefore detected. Consistently rolling back both activity roots is outside the same privileged multi-root threat boundary already stated for capability plus witness roots.

Every 4096 committed activities, before pruning, the helper O_EXCL-writes/fsyncs the next checkpoint receipt `{format:1,checkpointGeneration,entrySha256,previousCheckpointSha256,cumulativeSha256,createdAt}`, updates/fsyncs the external head to bind it, then deletes rows older than the previous checkpoint and runs bounded `incremental_vacuum`. The database retains at most 8193 rows and 32 MiB. Runtime/startup verification checks the fixed schema/pragmas, SQLite integrity, external head, latest checkpoint receipt, previous checkpoint link, and at most the current 4096-row segment; it never scans lifetime history. A maintenance/full-audit verb streams the checkpoint chain with a 120-second wall watchdog before deployment evidence, while normal polling stays bounded. Checkpoint receipts are never pruned online; the hard ceiling is 100000 receipts, representing 409600000 activities. Reaching it fails closed and requires a separately reviewed archive format, not silent rollover. Synthetic million-activity capacity tests require the database bound, O(1) ordinary append work, O(4096) startup validation, no checkpoint-directory enumeration on runtime paths, and injected Pi-class budgets of 250 ms startup validation and 50 ms p99 append excluding storage-fault injection. Crash tests cover DB commit, hot journal, external head, checkpoint receipt/head, prune, and incremental-vacuum boundaries. The activity database and head-witness root are outside every farming-database, payload, compatibility, migration, and recovery backup; evidence backup may copy them read-only, but no restore, GC, or rollback path may copy an older image back, delete, truncate, or replace them.

Every capability state change exclusively creates the next zero-padded generation file and same-number witness in the independent root. Each unknown-field-rejecting generation has `format`, positive `generation`, `previousGeneration`, `previousSha256`, one-use `operationId`, `kind:'HISTORICAL_V2_DISPOSITION'|'NEGOTIATED'|'RESET_AUTHORIZATION'|'DATABASE_RESTORE_INVALIDATION'|'DATABASE_RESTORE_RECONCILED'|'DATABASE_INTEGRITY_INVALIDATION'|'DATABASE_INTEGRITY_RECONCILED'`, `createdAt`, and exact `state`; its witness has only `format`, `generation`, `generationSha256`, `previousWitnessSha256`, and the same `operationId`. Every generation except the four database invalidation/reconciliation kinds preserves the exact prior `databaseRestore` object. A disposition generation retains exactly `activeIdentitySha256:null` and `mode:'UNNEGOTIATED'`, then carries a closed `sourceKind:'zero'|'rebind'|'quarantine'|'restore-invalidation'` plus its source-specific hashes. Zero additionally carries a closed `sourceAuthorityKind:'deployment-backup'|'factory-baseline'`: deployment zero binds the immutable backup-bound disposition receipt, audit, database, backup, and identity hashes; factory zero instead binds the ROM provenance, image manifest, factory seed/live-database identity, factory-zero audit/source receipt, image-baseline operation/generation, and all-root absence intent, and forbids backup or linked-identity fields. Rebind/quarantine retain the deployment backup-bound fields. Zero/rebind set `historicalV2Disposition:'CLEAR'`; quarantine/restore-invalidation set `RECONCILIATION_REQUIRED`. `CLEAR` permits negotiation only; command polling additionally requires the later valid `NEGOTIATED` generation in `LEGACY_V2|V3_PINNED` for that receipt-bound identity and `databaseRestore.status:'CLEAR'`. Purpose-specific restore-invalidation is legal only when a CLEAR generation was committed before disposition-database restore; it binds the linked recovery operation/phase, immutable restore-preparation result, purpose-specific restore receipt, restored-database audit, that prior CLEAR generation, and identity hashes, and forbids a source disposition receipt. A no-CLEAR disposition restore records its result only in the deployment recovery receipt and leaves the existing blocking capability state unchanged. A disposition may not carry fields from another source kind/authority or negotiation/reset fields. The later negotiation state carries `identitySha256`, `normalizedServerBase`, `gatewayDeviceEui`, nullable `capabilityProofSha256`, and retained CLEAR receipt hash. A reset state uses `RESET_AUTHORIZED` plus target active identity/mode, `authorizationId`, `confirmationSha256`, `fromIdentitySha256`, `toIdentitySha256`, `resetEpoch`, `resetAuthorizedAt`, and `resetReasonSha256`. Cross-kind fields fail.

A general farming-database replacement is a separate protocol event. `DATABASE_RESTORE_INVALIDATION` preserves the active identity, negotiation mode, historical disposition, and reset epoch, increments `databaseRestore.restoreEpoch`, and sets `databaseRestore.status:'RECONCILIATION_REQUIRED'`. Its typed receipt binds the linked recovery operation, general backup identity plus whole-database/command audits, readable pre-restore live database identity/audits, command-activity database and independent external head, capability generation/head/witness, available immutable command-state snapshot, replacement reason, and database-lineage invalidation receipt when applicable. Unreadable current state, unavailable snapshot, and non-command database delta reject before this generation. It commits before the first main/WAL/SHM/journal rename, copy, quarantine, or replacement. `DATABASE_RESTORE_RECONCILED` is legal only for that same epoch and preserves the active identity/mode; it sets status back to `CLEAR` only after the restored database, merge receipt, post-merge whole-database/command audits, activity roots, and exact reviewed reconciliation result reverify. `DATABASE_INTEGRITY_INVALIDATION` is a distinct explicit-authority path for a latched missing/corrupt current database: it preserves identity/mode, advances the restore epoch, binds the latch observation, trusted backup, forensic destination, activity roots, and manual-loss acknowledgement, and blocks startup before SQLite-set mutation without pretending to audit unreadable current rows. `DATABASE_INTEGRITY_RECONCILED` may clear only that epoch after the reviewed import-or-cutoff authority, restored/final audits, forensic inventory, and zero-effect receipt all reverify. Every restore, disposition, reset, and database-restore generation O_EXCL-creates and fsyncs its permanent typed receipt before the head may advance. Authorization/disposition/database-restore/database-integrity receipts and generations are never deleted or compacted by this plan.

`normalizedServerBase` uses WHATWG URL rules: require HTTPS, forbid userinfo/query/fragment, lowercase the canonical hostname, omit port 443, retain an explicit non-default port, and normalize the retained base path. Derive it from the exact effective URL returned by the same production resolver used to build the HTTP request, and require it to agree with the normalized linked `sync_link_state.server_url`; divergence fails before transport. `identitySha256` hashes canonical `peer_node`, that effective server base, linked `cloud_user_id`, and uppercase linked gateway EUI. Raw user IDs, tokens, origins, and credentials never enter logs. `capabilityProofSha256` hashes canonical non-secret facts only: identity hash, pending endpoint path, HTTP 200, protocol header value 3, response protocol value 3, edge fixture SHA256, and validator format/version; it excludes lease tokens and payload bytes.

Generation 0 cannot negotiate. With writers stopped, the initialization audit must first classify every historical unscoped v2 terminal/effect/outbox/reference row and `record-v2-disposition` must commit `CLEAR` or fail-closed `RECONCILIATION_REQUIRED`. Only `CLEAR` may negotiate the first linked identity, recording `V3_PINNED` after a valid v3 proof or `LEGACY_V2` after the isolated initial 404. A later valid v3 proof may monotonically upgrade that same legacy identity to `V3_PINNED` without reset; because both protocols share the same identity-scoped outcome key, an old v2 outcome remains replay evidence and receives a fresh v3 transport projection without rerunning its effect. No response can downgrade it. Once any identity is active, unlink stops polling but never clears history; relinking the same identity retains its mode. Any server-base, cloud-user, or gateway-EUI drift fails before transport. It cannot look like a fresh identity. Only a reset record may authorize the exact `fromIdentitySha256 -> toIdentitySha256` transition and one new negotiation epoch.

Create `/data/osi-sync` without symlink components at mode 0700 for the Node-RED service identity; generation, receipt, head, and activity-database files are 0600. Every load independently enumerates lstat-regular capability generations and witnesses and verifies both complete file chains. Activity verification first takes the stable activity lock. An absent sidecar opens the database read-only. An exact regular, nonsymlink, service-owned mode-0600 `activity.sqlite-journal` is the sole recoverable sidecar: the shared helper opens the database read-write through an injected recovery-only adapter, permits SQLite's own rollback-journal recovery but executes no DDL/DML/pragma mutation, closes, requires the journal absent, then reopens read-only. `-wal`, `-shm`, extra journals, wrong ownership/mode/type, recovery timeout/failure, or any adapter-observed SQL write blocks. It then checks fixed schema/pragmas, runs `quick_check`, verifies the independent external head/checkpoint plus only the bounded retained segment, requires one same-number capability witness for every capability generation with exact hashes/operation IDs, verifies every reset, historical-v2-disposition, or database-restore receipt against its typed generation, and requires each head to identify its highest committed hash. Replacing a head with an older valid pointer, deleting a tail and restoring its older head, rolling back any one root, inserting a fork/gap, removing a referenced typed receipt/generation/witness, corrupting or replacing the activity database, or replaying an operation blocks polling. A single valid next capability-generation proposal whose previous hash equals the head represents a crash before head publication; resume revalidates its operation and typed receipt before publishing that exact head. A reset proposal missing its permanent receipt may resume only from unchanged, unexpired root-owned confirmation, exact old head/witness, identical transition hashes, and no conflict. A deployment zero/rebind/quarantine disposition proposal missing its permanent receipt may resume only with writers stopped, unchanged immutable backup-bound source disposition receipt/path/hash, exact old head/witness, and identical database/identity/row-set hashes. A factory-zero genesis or disposition prefix may resume only from the unchanged ROM provenance, image-baseline operation/generation, all-root absence intent, seed/live-database identity, and factory audit/source receipt. A purpose-specific restore-invalidation proposal missing its receipt may resume only from the unchanged linked recovery operation/`disposition-restoring` phase, restore-preparation result, purpose-specific restore receipt, restored-database audit, prior CLEAR generation, identity, and exact old heads. A general database-restore proposal missing its receipt may resume only from its unchanged linked recovery phase, backup/current audits, activity head, snapshot status/hash, database-lineage invalidation identity, and exact old capability heads. It deterministically O_EXCL-creates/fsyncs that typed receipt, then continues witness/head publication. Missing source authority, changed disposition/authorization/recovery, cross-kind fields, or any other unheaded tail is reconciliation-required and fails closed.

Every capability change takes one process-local lock plus stable exclusive locks for the four physical roots in fixed activity-head-witness, activity-database, capability-witness, then capability-root order, containing PID, boot ID, all head identities, operation ID, source kind/authority, and typed receipt hash when required. A witnessed operation locks both activity roots and refuses to run while capability state is missing, malformed, or database-restore-blocked. A live same-boot owner blocks; stale-lock reconciliation first verifies the affected capability chain or bounded activity checkpoint/segment and permits only deterministic completion of the recorded proposal or a new operation when no proposal names the stale operation. Write/fdatasync the O_EXCL capability generation, then its required reset, disposition, or database-restore receipt, fsync the typed receipt/generation directories, O_EXCL-create/fdatasync the matching capability witness and its directory, then atomically replace/fsync capability `head.json`. Activity commits and external-head publication follow their separate crash protocol above. A crash before capability generation creation changes nothing; a crash after a typed generation but before receipt follows its source rule; after generation/receipt it resumes the missing witness; after witness it resumes the exact head. Test reset, both zero authorities, all disposition source kinds, both database-restore kinds, and command activity at intent/generation/receipt/witness/head/SQLite/external-head/checkpoint boundaries, with changed/missing source facts, cross-kind conflict, and committed-head cleanup pending. The capability chain alone has a 4096-generation ceiling and no online pruning. Activity uses the bounded rolling database plus permanent checkpoint receipts and 100000-checkpoint ceiling defined above. Evidence backup may copy all roots read-only; restore, recovery, and GC may compare those copies but never write them back, delete live roots, or downgrade heads. This detects every in-scope partial write and rollback of one physical root, including activity-database rollback against its external head. A privileged actor that consistently rolls back all independent roots is outside the software-only threat model and requires a hardware monotonic counter or external witness; the plan states this limit rather than claiming tamper resistance.

Once v3 has succeeded for an identity, timeout, 4xx/5xx, missing header, redirect, malformed body, token loss, reboot, and Node-RED restart fail closed. `authorize-reset` is the sole downgrade/identity-transition authority. It requires Node-RED stopped, a fresh exact live database/capability-chain backup, and a clean stopped-writer `audit-command-ack-state.js` result with zero active ACK, outbox, retry, or external-intent rows for either v2 or v3 and zero historical-unscoped rows of any lifecycle state. Old-identity active rows must first be copied to the immutable backup-bound quarantine and deleted by the exact reset reconciliation transaction; terminal identity-scoped rows may remain because they cannot match the target identity. Its consumed root-owned mode-0600 confirmation has exactly `{format,authorizationId,expectedHeadSha256,expectedWitnessSha256,expectedGeneration,fromIdentitySha256,toIdentitySha256,reason,expiresAt}`. The new reset generation and permanent reset receipt retain the authorization ID, confirmation hash, transition, epoch, and reason hash. A crash before generation creation changes nothing; a crash after proposal/receipt creation resumes the same operation; head publication commits it even if confirmation cleanup remains. Resume consumes or quarantines the matching confirmation without another generation. Stale head/witness/generation, expired confirmation, any existing authorization receipt, mismatched transition, unsafe cross-protocol ACK state, missing backup, or online writer changes nothing.

After reset, the exact target identity may negotiate once, recording `LEGACY_V2` on initial 404 or `V3_PINNED` on valid v3 proof. The protected pending envelope then carries exact `ackProtocol:3` plus `leaseToken`, or isolated `ackProtocol:2` with no token. Both protocols use the protocol-stable identity-scoped `cloud:` outcome key; transport generations remain protocol-specific, and wire command IDs/v2 bytes remain unchanged. Producers, queueing, endpoint selection, and response classification reject cross-protocol transport or cross-identity mixing.

Add deployment and factory initialization/first-absence/post-install-loss, both zero authorities, historical-v2 rebind/quarantine, old-server v2 binding, v2→v3 same-command replay, first v3 pin, reboot/restart, pinned-server outage, redirect, effective-resolver/link-URL divergence, origin/link/gateway identity drift, forged header, mixed batch, capability head rollback, activity-database-only rollback against a newer external head, external-head-only rollback, capability generation-tail plus old-head rollback, witness-tail rollback, generation/witness/receipt/checkpoint deletion/fork/gap/symlink/mode/hash mismatch, lock PID/boot reconciliation, hot-journal recovery, crash around disposition/generation/receipt fsync and head publication, capability 4096-generation exhaustion, activity checkpoint capacity, clean-audit reset prerequisite, permanent authorization replay, confirmation cleanup/race, and attempted downgrade tests. Factory tests cover nonzero/malformed seed state, first/second-boot audit, intent, capability/activity genesis, immutable generation-0 activity anchor, CLEAR generation/receipt/witness/head boundaries, partial root state, deleted committed root, marker-before-CLEAR, and runtime invocation. Purpose-restore tests classify no CLEAR proposal/head, one valid unheaded CLEAR proposal, committed CLEAR, malformed or mismatched CLEAR proposal, and any dependent NEGOTIATED state before touching the database. The CLI and flow use one helper parser/chain writer and strict v3 validator; no shell or flow node reimplements the state format.

Pin the exact live CLI forms. Unknown/duplicate flags, stdin, relative/symlinked paths, extra positional arguments, and wrong verb fields fail. Each success prints one bounded JSON line containing only state SHA256, generation, mode, active identity hash, and operation result:

```text
node /rom/usr/libexec/osi-sync-protocol-capability-cli.js initialize-factory-zero \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-baseline-id <id> --expected-phase image-baseline-initializing \
  --expected-baseline-prefix baseline-completing \
  --expected-parent-generation <n> --operation-id <id> \
  --factory-provenance /rom/usr/share/osi-deploy/factory-image-provenance.json \
  --image-guard-manifest /rom/usr/share/osi-deploy/image-guard-manifest.json \
  --factory-seed-receipt <absolute-root-owned-json> \
  --database /data/db/farming.db \
  --ack-audit-report <absolute-factory-zero-json> \
  --factory-intent-out <absolute-absent-root-owned-json> \
  --factory-zero-source-receipt-out <absolute-absent-root-owned-json>
node scripts/sync-protocol-capability-cli.js initialize \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-deployment-id <id> \
  --expected-phase protocol-initializing \
  --expected-parent-generation <n> --operation-id <id> \
  --ack-audit-report <absolute-stopped-writer-json> \
  --backup-manifest <absolute-attempt-bound-json> \
  --expected-capability-head-sha256 <sha|absent> \
  --expected-witness-head-sha256 <sha|absent>
node scripts/sync-protocol-capability-cli.js status \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses
node scripts/sync-protocol-capability-cli.js record-v2-disposition \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-deployment-id <id> --expected-phase protocol-dispositioning \
  --expected-parent-generation <n> --operation-id <id> \
  --ack-audit-report <absolute-stopped-writer-json> \
  --backup-manifest <absolute-attempt-bound-json> \
  --disposition-receipt <absolute-backup-bound-json> \
  --expected-disposition-receipt-sha256 <sha> \
  --expected-identity-sha256 <sha> \
  --expected-head-sha256 <sha> \
  --expected-witness-sha256 <sha>
node scripts/sync-protocol-capability-cli.js prepare-disposition-restore \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-deployment-id <id> --expected-parent-generation <n> \
  --recovery-operation-id <id> \
  --expected-recovery-phase disposition-restore-preparing \
  --ack-audit-report <absolute-current-rebound-json> \
  --backup-manifest <absolute-attempt-bound-json> \
  --expected-backup-sha256 <sha> --expected-identity-sha256 <sha> \
  --expected-head-sha256 <sha> --expected-witness-sha256 <sha> \
  --prepare-intent-out <absolute-absent-root-owned-json> \
  --result-out <absolute-absent-root-owned-json>
node scripts/sync-protocol-capability-cli.js invalidate-v2-disposition \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-deployment-id <id> --expected-parent-generation <n> \
  --recovery-operation-id <id> --expected-recovery-phase disposition-restoring \
  --restore-preparation-result <absolute-root-owned-json> \
  --restore-receipt <absolute-root-owned-json> \
  --ack-audit-report <absolute-restored-db-json> \
  --expected-identity-sha256 <sha> \
  --expected-head-sha256 <sha> --expected-witness-sha256 <sha>
node scripts/sync-protocol-capability-cli.js prepare-database-restore \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-deployment-id <id> --expected-parent-generation <n> \
  --recovery-operation-id <id> --expected-recovery-phase database-restore-preparing \
  --backup-manifest <absolute-attempt-bound-json> \
  --restore-baseline <absolute-immutable-baseline-json> \
  --reverse-merge-adapter-inventory <absolute-artifact-owned-json> \
  --backup-command-audit-report <absolute-backup-bound-json> \
  --backup-farming-audit-report <absolute-backup-bound-json> \
  --current-command-audit-report <absolute-current-json|current-database-unreadable-json> \
  --current-farming-audit-report <absolute-current-json|current-database-unreadable-json> \
  --current-snapshot <absolute-absent-root-owned-sqlite|snapshot-unavailable-json> \
  --database-lineage-invalidation-receipt <absolute-root-owned-json|not-applicable> \
  --expected-head-sha256 <sha> --expected-witness-sha256 <sha> \
  --expected-activity-generation <n> --expected-activity-head-sha256 <sha> \
  --prepare-intent-out <absolute-absent-root-owned-json> \
  --result-out <absolute-absent-root-owned-json>
node scripts/sync-protocol-capability-cli.js complete-database-restore-reconciliation \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-deployment-id <id> --expected-parent-generation <n> \
  --recovery-operation-id <id> --expected-recovery-phase database-restore-reconciling \
  --prepare-result <absolute-root-owned-json> \
  --merge-receipt <absolute-root-owned-json> \
  --reverse-merge-adapter-inventory <absolute-artifact-owned-json> \
  --post-merge-audit-report <absolute-root-owned-json> \
  --expected-head-sha256 <sha> --expected-witness-sha256 <sha> \
  --expected-activity-generation <n> --expected-activity-head-sha256 <sha>
node scripts/sync-protocol-capability-cli.js prepare-integrity-recovery \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --recovery-request /data/osi-deploy/database-recovery-required.json \
  --authority <absolute-root-owned-json> --backup-manifest <absolute-journal-bound-json> \
  --database-lineage-invalidation-receipt <absolute-root-owned-json|not-applicable> \
  --forensic-destination <absolute-absent-root-owned-directory> \
  --result-out <absolute-absent-root-owned-json>
node scripts/sync-protocol-capability-cli.js complete-integrity-recovery \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --recovery-request /data/osi-deploy/database-recovery-required.json \
  --reconciliation-authority <absolute-root-owned-json> \
  --forensic-inventory <absolute-root-owned-json> \
  --cloud-comparison <absolute-root-owned-json> \
  --recovered-rows-manifest <absolute-root-owned-json|not-applicable> \
  --offline-import-manifest <absolute-root-owned-json|not-applicable> \
  --accepted-loss-boundary <absolute-root-owned-json|not-applicable> \
  --command-capability-cutoff-proof <absolute-root-owned-json|not-applicable> \
  --historical-revalidation-receipt <absolute-root-owned-json> \
  --post-reconcile-command-audit <absolute-root-owned-json> \
  --post-reconcile-farming-audit <absolute-root-owned-json>
node scripts/sync-protocol-capability-cli.js authorize-reset \
  --root /data/osi-sync \
  --witness-root /data/osi-sync-witness/protocol-capability-witnesses \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --confirmation <absolute-root-owned-json> \
  --backup-manifest <absolute-attempt-bound-manifest> \
  --ack-audit-report <absolute-stopped-writer-report>
```

Pin the reconciliation CLI forms as well. `--operation-id` is generated and fsynced by the deployment journal before the spawned command; `--receipt-out` is an absent path under the attempt backup. Unknown/duplicate flags, mode-specific extras, relative/symlinked paths, stdin, changed audit/database/backup facts, or an unowned operation fail:

```text
node /rom/usr/libexec/osi-audit-command-ack-state.js factory-zero-audit \
  --database /data/db/farming.db \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-baseline-id <id> --expected-phase image-baseline-initializing \
  --expected-baseline-prefix baseline-completing \
  --expected-parent-generation <n> \
  --factory-provenance /rom/usr/share/osi-deploy/factory-image-provenance.json \
  --factory-seed-receipt /data/osi-deploy/receipts/<id>.factory-seed.json \
  --database-lineage /data/osi-deploy/factory-database-lineage.json \
  --expected-database-lineage-sha256 <sha> \
  --report-out /data/osi-deploy/factory-protocol/<id>/audit.json
node scripts/audit-command-ack-state.js audit \
  --database /data/db/farming.db \
  --activity-witness-root /data/osi-sync-witness/command-activity-witnesses \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-deployment-id <id> \
  --report-out <absolute-attempt-backup-path>
node scripts/audit-farming-database-state.js audit \
  --database /data/db/farming.db \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --expected-deployment-id <id> --expected-parent-generation <n> \
  --report-out <absolute-absent-root-owned-json>
node scripts/reconcile-command-ack-state.js record-zero \
  --database /data/db/farming.db --audit-report <absolute-json> \
  --backup-manifest <absolute-json> --expected-identity-sha256 <sha> \
  --operation-id <id> --receipt-out <absolute-json>
node scripts/reconcile-command-ack-state.js rebind-historical-v2 \
  --database /data/db/farming.db --audit-report <absolute-json> \
  --backup-manifest <absolute-json> --expected-identity-sha256 <sha> \
  --expected-prior-origin-sha256 <sha> --operation-id <id> \
  --receipt-out <absolute-json>
node scripts/reconcile-command-ack-state.js quarantine-historical-v2 \
  --database /data/db/farming.db --audit-report <absolute-json> \
  --backup-manifest <absolute-json> --expected-identity-sha256 <sha> \
  --operation-id <id> --receipt-out <absolute-json>
node scripts/reconcile-command-ack-state.js quarantine-reset-active \
  --database /data/db/farming.db --audit-report <absolute-json> \
  --backup-manifest <absolute-json> --reset-confirmation <absolute-json> \
  --operation-id <id> --receipt-out <absolute-json>
node scripts/reconcile-command-ack-state.js merge-database-restore-state \
  --database /data/db/farming.db \
  --deployment-state /data/osi-deploy/deployment-state.json \
  --recovery-operation-id <id> \
  --restored-audit-report <absolute-root-owned-json> \
  --prepare-result <absolute-root-owned-json> \
  --snapshot-manifest <absolute-root-owned-json> \
  --backup-manifest <absolute-root-owned-json> \
  --restore-baseline <absolute-root-owned-json> \
  --reverse-merge-adapter-inventory <verified-artifact>/manifests/database-restore-reverse-adapters.json \
  --recovery-implementation-manifest <verified-artifact>/manifests/database-recovery-implementations.json \
  --expected-activity-generation <n> --expected-activity-head-sha256 <sha> \
  --receipt-out <absolute-absent-root-owned-json>
```

`factory-zero-audit` is read-only except for O_EXCL publication of its mode-0600 report and delegates row classification plus lineage validation to the same audit/factory-seed codecs as ordinary deployment. It requires the exact second-boot parent/prefix/generation, baseline ID, provenance, seed receipt, lineage record/hash, stopped-role evidence, and absent output; it derives and requires `factorySeedEligible:true`. `complete-image-baseline` spawns exactly this argv from the ROM-bound executable and hashes the executable/argv/report into its next prefix before invoking protocol initialization. Direct tests spawn both audit verbs, delete or swap the ROM executable, alter every factory flag/parent/lineage/counter, reuse the output, and prove import-only or ordinary unbound `audit` cannot satisfy factory completion.

`initialize-factory-zero` reads the deployment-state file through the manifest-owned library and accepts only the exact second-boot `image-baseline-initializing/baseline-completing` operation. It verifies the ROM manifests/helpers, first-boot all-root absence and seed/lineage receipts, exact `databaseLineageSha256`, a stopped-writer report whose shared validator derived `factorySeedEligible:true`, and absent root-owned intent/source-receipt outputs. Under the shared root locks it O_EXCL-writes/fsyncs the factory intent and factory-zero source receipt before creating or resuming capability genesis, command-activity genesis plus external head witness, and the zero/CLEAR typed generation, receipt, witness, and head. Success returns the committed CLEAR capability/witness anchor hashes, immutable command-activity `{generation:0,entrySha256}` anchor hash, and disposition receipt; only the image-baseline coordinator may bind all three anchors into `factory-protocol-ready`. Later negotiation or command activity may append descendants, while factory startup always verifies the immutable anchors remain at their original positions in all three logical chains. `initialize` remains deployment-only: it rejects caller Booleans and every phase other than the exact journalled `protocol-initializing` generation/operation. `record-v2-disposition` normally requires `protocol-dispositioning`, the same deployment operation/generation, stopped-writer guard, exact live database/backup/audit/identity facts, immutable source receipt, and unchanged generation/witness/activity heads. Its sole additional authority is the same recovery in `integrity-historical-dispositioning` when integrity initialization created genesis with historical `UNASSESSED`, active identity is null, `databaseRestore.status` remains `RECONCILIATION_REQUIRED`, the fresh restored final-database audit and backup bind the recovery/epoch, and all heads match; it emits only typed CLEAR or blocking quarantine while preserving the database-restore object. A deployment zero-row or complete same-origin rebind receipt advances to `CLEAR`; a quarantine receipt advances only to `RECONCILIATION_REQUIRED`, which remains a polling block until a later reviewed complete rebind/reconciliation produces a new `CLEAR` receipt.

`prepare-disposition-restore` is the sole pre-restore classifier/preparer. It uses the same helper parser and fixed command-activity-root, capability-witness-root, then capability-root lock order; verifies the linked recovery in its purpose-specific disposition-restore preparation phase, purpose backup, current rebound-database audit, identity, source disposition facts, all expected heads, and root-owned absent intent/result paths; and O_EXCL-writes an immutable preparation intent before any chain completion. Its closed result is one of four values:

| Result | When it is legal | Helper chain mutation |
|---|---|---|
| `NO_CLEAR` | No CLEAR proposal and no committed CLEAR generation exist for the source disposition | None |
| `UNHEADED_CLEAR_COMPLETED` | Exactly one valid next CLEAR proposal whose source facts still match | Deterministically completes the missing typed receipt, witness, and head before writing the result |
| `COMMITTED_CLEAR` | A committed CLEAR generation already heads the chain | None |
| `REJECTED` | Malformed or mismatched CLEAR proposal, or any dependent NEGOTIATED state; carries one bounded reason from `MALFORMED_PROPOSAL\|MISMATCHED_PROPOSAL\|DEPENDENT_NEGOTIATED` and exits nonzero | None |

The intent/result bind recovery ID, parent generation, database/audit/backup/identity hashes, observed proposal/generation/receipt/witness/activity/head hashes, pre/post heads, branch, and completion operation. A crash or already-completed same-recovery retry verifies the immutable intent and reconstructs only its exact missing result; a different recovery, changed fact, second proposal, or branch reinterpretation fails. Shell consumes the result and never parses a capability generation, witness, activity, proposal, or typed receipt.

`audit-farming-database-state.js` is the whole-database boundary. In one stopped-writer read transaction it validates `quick_check`, hashes the complete non-internal `sqlite_schema`, enumerates every application table without an allowlist, and emits sorted per-table row counts/hashes plus one full logical hash. Values use a shared type-tagged, length-prefixed canonical codec for null, safe/unsafe SQLite integers, finite reals, text bytes, and blobs. Rows sort by declared primary key and then canonical full-row bytes; tables without a primary key sort by canonical full-row bytes while preserving duplicate multiplicity. Views/indexes/triggers contribute schema bytes; virtual/special tables require an explicit tested codec or reject. It binds database device/inode, schema/user versions, table inventory hash, and two identical repeated reads. Adding/removing a table, changing only a sensor row, sync cursor/outbox, local journal/config/API row, delivered ACK, or duplicate row changes the report. The backup manifest stores this report beside the command audit.

A sealed restore baseline separates an expected deployment mutation from later runtime data. With every writer inhibited, the controller O_EXCL-writes and parent-fsyncs it immediately after the authorized database mutation commits and before any application process, probe, or role can start. A no-mutation attempt seals a backup-equivalent baseline immediately after backup. An ordered migration or repair/baseline transform seals the post-commit command and whole-database audits plus the exact manifest-owned unit IDs, checksums, risk classes, runner receipt, and sorted backup-to-baseline schema/table/ledger delta. A crash after commit but before sealing may complete only the same baseline when the deployment journal, migration ledger, and runner receipt prove the exact committed unit set and activity, capability, and writer generations have not moved; a rolled-back transaction seals the backup-equivalent form, while ambiguous or partially applied state is rejected. Expected schema, migration-ledger, data-backfill, or new-table changes are legal only inside this reviewed backup-to-baseline delta and never count as post-baseline application activity.

`prepare-database-restore` is the sole authority for any general migration rollback, operator restore, or ordinary recovery path that will replace the farming main file or its SQLite set. It runs with every guarded writer stopped, application links absent or inhibited, and the linked recovery in `database-restore-preparing`. It verifies the independent activity roots, complete capability/witness chains, exact general backup manifest, immutable sealed restore baseline, baseline/current command audits, baseline/current whole-database audits, the current database-lineage state, and absent intent/result paths. Its closed result is `NO_POST_BACKUP_DATABASE_DELTA`, `EXPECTED_DEPLOYMENT_MUTATION_ONLY`, `RECONCILIATION_REQUIRED`, or `REJECTED`.

`NO_POST_BACKUP_DATABASE_DELTA` requires backup, sealed baseline, and current whole-database schema/table/full logical hashes plus command/effect/outcome/ACK/outbox/retry/reference hashes and counters to be equal, with unchanged command-activity database/external head witness, capability generation/head/witness, and guarded writer generation. `EXPECTED_DEPLOYMENT_MUTATION_ONLY` instead requires current to equal the sealed post-mutation baseline exactly, every backup-to-baseline difference to equal the manifest-owned expected-delta report and runner receipt, and the same activity/capability/writer facts to be unchanged from backup through preparation. Neither branch relies on timestamps, file bytes, row counts alone, Node-RED absence at restore time, or a caller Boolean. Both restore only the backup image; afterward the command and whole-database audits must equal the backup audits and all independent heads/generations must still match before startup authorization.

If current differs from the sealed baseline, the helper compares every per-table hash against the command-owned table/domain-postcondition inventory from `verify-command-ledger-consumers.js`. A post-baseline delta confined to the complete registered command/replay set may select `RECONCILIATION_REQUIRED`; when the baseline contains a deployment mutation, every changed command family must also have a manifest-bound reverse merge adapter into the backup schema. Any post-baseline sensor/device-data, sync outbox/inbox/cursor, local journal/config/API, migration metadata, schema, unknown/new table, or other non-command delta returns `REJECTED` with `NON_COMMAND_DATABASE_DELTA` and performs no snapshot, invalidation, or restore. Expected migration schema/ledger/backfill/new-table differences that exactly match the sealed backup-to-baseline report are not reclassified as runtime deltas. `CURRENT_DATABASE_UNREADABLE`, incomplete whole-database audit, missing table codec or reverse adapter, process-generation uncertainty, or missing producer inventory is also `REJECTED` for automatic general recovery. It can never be downgraded to an automatic branch.

For `RECONCILIATION_REQUIRED`, the helper itself creates a root-owned mode-0600 SQLite online snapshot at the required absent `--current-snapshot` path, verifies and fsyncs it, and binds the complete command-effect/reference and per-family domain-postcondition inventory; no shell-created copy is accepted. Snapshot failure publishes the closed rejected-only `SNAPSHOT_UNAVAILABLE` record and `REJECTED` result, then exits before capability or farming-database mutation. With an available snapshot, ordering is preparation intent, snapshot/manifest, typed `DATABASE_RESTORE_INVALIDATION` generation, permanent receipt, capability witness, capability head, and preparation result last. Only that final result grants permission to mutate the SQLite set. The invalidation retains active identity and mode but blocks negotiation, pending polling, dispatch, ACK delivery, every live Node-RED start, and every `recovery-health` live permit. Other rejected evidence likewise performs no database or chain mutation. A crash before or after intent, snapshot, generation, receipt, witness, head, or result resumes only the same recovery/epoch from unchanged hashes.

`merge-database-restore-state` then runs while all live writers remain stopped. It transactionally imports the complete post-baseline replay evidence and only those command-driven domain postconditions whose producer-specific, migration-version-aware reverse merge adapter proves an exact idempotent SQLite state in the backup schema. It never calls a command handler, emits a downlink/RPC, sends an ACK, or reconstructs a secret. It preserves terminal outcomes, effect intents/completions, ACK outbox/retry generations, valve expectations, journal, and every inventoried reference. Before mutation the helper derives an exact expected post-merge audit from the backup's non-command state plus the converted command inventory; after commit the command audit must equal the converted current semantic report and the whole-database audit must equal that expected report. It never requires the restored database to reproduce the intentionally discarded deployment-mutation schema/backfill. A collision, missing source row, partial reference set, unrecognized family, missing reverse adapter, at-most-once or ambiguous external effect, changed restored database, orphaned postcondition, or audit mismatch rolls back and leaves the epoch blocked for reviewed operator reconciliation. Its immutable receipt binds before/after row-set and whole-database hashes, the expected post-merge audit, adapter inventory, counts, snapshot, baseline, backup, restored database, both activity heads, restore epoch, and zero external-effect/transport calls.

The merge argv block above is the sole mutating form. Before opening the target database read-write, it verifies the artifact root/control manifest, both exact manifest hashes, every implementation byte, source/target schema tuple, and the preparation/snapshot bindings; crash resume requires the identical inventory and implementation manifest. Missing or changed arguments/files fail before `BEGIN`.

`complete-database-restore-reconciliation` accepts only that same linked `database-restore-reconciling` operation and epoch. It verifies the merge receipt, repeated stopped-writer whole-database/command audits, exact restored/merged database identity, unchanged activity database/external head, current capability heads, and a closed result with no ambiguous effect/reference. It then appends `DATABASE_RESTORE_RECONCILED` and its typed receipt/witness/head. Only the reverified reconciled head can restore protocol/startup eligibility; ordinary CLEAR/NEGOTIATED state below an invalidation generation is insufficient. Unsafe external effects or incomplete command references prevent merge/reconciliation and leave the gateway inhibited; unavailable snapshots, unreadable current databases, and non-command deltas were rejected before replacement and require separately reviewed manual/forward recovery.

Pin the general-restore JSON contracts rather than leaving adapters to infer them. Every object below rejects unknown fields, uppercase/short hashes, unsafe integers, non-UTC timestamps, unsafe paths, unsorted/duplicate arrays, and cross-branch fields. Canonical JSON hashes the exact object without any `*Sha256` field that names its own bytes.

- A whole-database audit is exactly `{format:1,databasePath:'/data/db/farming.db',databaseIdentitySha256,schemaVersion,userVersion,schemaSha256,tableInventorySha256,tables:[{name,rowCount,rowSetSha256}],fullLogicalSha256,quickCheck:'ok',firstReadSha256,secondReadSha256,createdAt}`. `tables` is sorted by name and includes every application table.
- Expected deployment delta at `/data/osi-deploy/database-restore-baselines/<deployment-id>/<mutation-operation-id>.delta.json` is exactly `{format:1,kind:'EXPECTED_DEPLOYMENT_DATABASE_DELTA',deploymentId,mutationOperationId,mutationKind:'none'|'ordered-migration'|'repair-baseline',orderedUnits:[{id,checksumSha256,riskClass:'additive'|'destructive'|'data'}],schemaAdded:[{type,name,sqlSha256}],schemaRemoved:[{type,name,sqlSha256}],schemaChanged:[{type,name,beforeSqlSha256,afterSqlSha256}],tableDeltas:[{name,beforeRowCount,beforeRowSetSha256,afterRowCount,afterRowSetSha256}],migrationLedgerBeforeSha256,migrationLedgerAfterSha256,createdAt}`. Every array is sorted/unique. The `none` branch requires empty arrays and equal ledger hashes; other branches require the exact manifest-owned unit sequence and runner receipt to produce these bytes.
- Recovery implementation manifest in the exact-commit artifact at `manifests/database-recovery-implementations.json` is exactly `{format:1,kind:'DATABASE_RECOVERY_IMPLEMENTATIONS',files:[{implementationId,path,mode:420|493,sizeBytes,sha256}]}`. Files are sorted/unique, regular nonsymlinks inside the artifact, and include every reverse-merge adapter, integrity import adapter, dataset/source verifier, and their parser dependencies. It is produced and hashed before the outer deployment-control manifest, which includes it; it never hashes the outer manifest, so no cycle exists. Every adapter `codeSha256` equals its listed implementation file hash.
- Reverse-merge adapter inventory in the exact-commit deployment artifact at `manifests/database-restore-reverse-adapters.json` is exactly `{format:1,kind:'DATABASE_RESTORE_REVERSE_ADAPTER_INVENTORY',implementationManifestSha256,adapters:[{adapterId,commandFamily,sourceSchemaVersion,sourceSchemaSha256,targetSchemaVersion,targetSchemaSha256,sourceTables,targetTables,implementationId,codeSha256}]}`. Arrays and table names are sorted/unique and nonempty. Exactly one adapter may own each `(commandFamily,sourceSchemaSha256,targetSchemaSha256)` tuple; version ranges, wildcards, overlapping table ownership, duplicate families, missing implementation bytes, or an adapter outside the verified implementation manifest are invalid.
- Sealed baseline beside that report is exactly `{format:1,kind:'DATABASE_RESTORE_BASELINE',deploymentId,mutationOperationId,mutationKind:'none'|'ordered-migration'|'repair-baseline',backupManifestSha256,backupCommandAuditSha256,backupFarmingAuditSha256,baselineCommandAuditSha256,baselineFarmingAuditSha256,expectedMutationDeltaSha256,orderedUnitManifestSha256,runnerReceiptSha256,reverseMergeAdapterInventorySha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,capabilityGeneration,capabilityHeadSha256,capabilityWitnessSha256,writerGeneration,createdAt}`. `none` requires null unit-manifest/runner hashes and backup-equal audits; mutation branches require hashes and exact report agreement. It is O_EXCL, mode 0600, parent-fsynced, and becomes immutable before any start permit.
- Current evidence at `/data/osi-deploy/database-restores/<recovery-id>/current-evidence.json` is either `{format:1,evidenceKind:'READABLE',databaseIdentitySha256,commandAuditSha256,farmingAuditSha256,createdAt}` or `{format:1,evidenceKind:'CURRENT_DATABASE_UNREADABLE',databasePath:'/data/db/farming.db',observedDatabaseIdentitySha256,quickCheckResult:'failed'|'timeout'|'unreadable',errorCode:'SQLITE_CHECK_FAILED'|'SQLITE_TIMEOUT'|'SQLITE_OPEN_FAILED',createdAt}`. The unreadable form is REJECTED-only for this general-restore protocol.
- Preparation intent at `prepare-intent.json` is exactly `{format:1,kind:'DATABASE_RESTORE_PREPARATION_INTENT',deploymentId,parentGeneration,recoveryOperationId,restoreEpochCandidate,backupManifestSha256,backupDatabaseSha256,backupCommandAuditSha256,backupFarmingAuditSha256,restoreBaselineSha256,expectedMutationDeltaSha256,reverseMergeAdapterInventorySha256,currentEvidenceSha256,capabilityGeneration,capabilityHeadSha256,capabilityWitnessSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,writerGeneration,databaseLineageInvalidationReceiptSha256,createdAt}`. The lineage field is a hash or null for legacy not-applicable.
- Snapshot manifest at `current-command-state.snapshot.json` is exactly `{format:1,status:'AVAILABLE',recoveryOperationId,restoreEpoch,snapshotPath,snapshotSizeBytes,snapshotSha256,databaseIdentitySha256,commandAuditSha256,farmingAuditSha256,reverseMergeAdapterInventorySha256,commandOwnedTables:[{name,rowCount,rowSetSha256}],createdAt}`. The rejected-only alternative is `{format:1,status:'SNAPSHOT_UNAVAILABLE',recoveryOperationId,databaseIdentitySha256,reason:'SQLITE_BACKUP_FAILED'|'SQLITE_CHECK_FAILED'|'INVENTORY_INCOMPLETE',createdAt}` and can never appear in an invalidation generation.
- Preparation result common fields are exactly `format:1`, `kind:'DATABASE_RESTORE_PREPARATION_RESULT'`, `deploymentId`, `parentGeneration`, `recoveryOperationId`, `intentSha256`, `backupManifestSha256`, `restoreBaselineSha256`, `expectedMutationDeltaSha256`, `currentEvidenceSha256`, and `createdAt`. `NO_POST_BACKUP_DATABASE_DELTA` adds only `{result,backupCommandAuditSha256,baselineCommandAuditSha256,currentCommandAuditSha256,backupFarmingAuditSha256,baselineFarmingAuditSha256,currentFarmingAuditSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,capabilityGeneration,capabilityHeadSha256,capabilityWitnessSha256,writerGeneration,proofSha256}` and requires all three audit pairs equal. `EXPECTED_DEPLOYMENT_MUTATION_ONLY` adds the same fields plus only `{mutationOperationId,mutationKind,orderedUnitManifestSha256,runnerReceiptSha256}` and requires baseline/current equality plus exact backup-to-baseline expected-delta agreement. `RECONCILIATION_REQUIRED` adds only `{result,restoreEpoch,baselineCommandAuditSha256,baselineFarmingAuditSha256,currentCommandAuditSha256,currentFarmingAuditSha256,changedCommandTables,reverseMergeAdapterInventorySha256,snapshotManifestSha256,invalidationReceiptSha256,invalidationGeneration,invalidationHeadSha256,invalidationWitnessSha256}`. `REJECTED` adds only `{result,reason,changedNonCommandTables,evidenceSha256}`, where reason is `NON_COMMAND_DATABASE_DELTA|CURRENT_DATABASE_UNREADABLE|SNAPSHOT_UNAVAILABLE|UNKNOWN_TABLE|EXPECTED_MUTATION_MISMATCH|REVERSE_MERGE_ADAPTER_MISSING|MALFORMED_EVIDENCE|ACTIVITY_HEAD_MISMATCH|CAPABILITY_MISMATCH|WRITER_GENERATION_MISMATCH`; `changedNonCommandTables` is nonempty only for the first/unknown-table reasons. Unowned/malformed recovery authority exits nonzero before intent/result publication.
- The permanent invalidation receipt at `/data/osi-sync/protocol-capabilities/database-restore-receipts/<restore-epoch>.invalidation.json` is exactly `{format:1,receiptKind:'database-restore-invalidation',operationId,deploymentId,parentGeneration,recoveryOperationId,restoreEpoch,predecessorGeneration,predecessorHeadSha256,predecessorWitnessSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,backupManifestSha256,restoreBaselineSha256,expectedMutationDeltaSha256,backupCommandAuditSha256,backupFarmingAuditSha256,baselineCommandAuditSha256,baselineFarmingAuditSha256,currentCommandAuditSha256,currentFarmingAuditSha256,reverseMergeAdapterInventorySha256,snapshotManifestSha256,databaseLineageInvalidationReceiptSha256,preparationIntentSha256,createdAt}`.
- Merge receipt at `/data/osi-deploy/database-restores/<recovery-id>/merge-receipt.json` is exactly `{format:1,receiptKind:'database-restore-merge',deploymentId,parentGeneration,recoveryOperationId,restoreEpoch,prepareResultSha256,restoreBaselineSha256,expectedMutationDeltaSha256,snapshotManifestSha256,restoredDatabaseIdentitySha256,beforeCommandAuditSha256,beforeFarmingAuditSha256,afterCommandAuditSha256,afterFarmingAuditSha256,expectedPostMergeFarmingAuditSha256,reverseMergeAdapterInventorySha256,reverseMergeImplementationManifestSha256,mergedTables:[{name,adapterId,insertedRows,updatedRows,unchangedRows,rowSetSha256}],activityGeneration,activityEntrySha256,activityExternalHeadSha256,externalEffectCalls:0,ackTransportCalls:0,result:'MERGED',createdAt}`.
- The permanent reconciled receipt at `/data/osi-sync/protocol-capabilities/database-restore-receipts/<restore-epoch>.reconciled.json` is exactly `{format:1,receiptKind:'database-restore-reconciled',operationId,deploymentId,parentGeneration,recoveryOperationId,restoreEpoch,invalidationGeneration,invalidationReceiptSha256,restoreBaselineSha256,expectedMutationDeltaSha256,mergeReceiptSha256,postMergeCommandAuditSha256,postMergeFarmingAuditSha256,expectedPostMergeFarmingAuditSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,predecessorHeadSha256,createdAt}`.

Direct codec and spawned-CLI tests mutate every field, add one unknown field at every nesting level, swap readable/unreadable and available/unavailable evidence, cross-inject each of the four result branches' fields, alter array order/multiplicity, swap epochs/operations, and remove each referenced artifact. They cover a no-mutation backup-equivalent baseline plus schema-only, migration-ledger-only, data-backfill, and new-table migration baselines; each exact expected delta may restore, while one later sensor/config/sync/schema write, runner-receipt mismatch, partial migration, or missing reverse adapter blocks. Crash tests cover commit-before-baseline, baseline-before-state-CAS, and exact same-operation completion. A schema-valid receipt without its cross-matching generation/witness/head or a valid generation without its receipt remains blocked. Reverse-adapter tests change implementation bytes after preparation, duplicate/overlap family ownership, widen a version tuple, swap source/target schemas or tables, delete the selected adapter, and resume under a changed inventory; each blocks before merge or keeps the epoch inhibited.

Database-integrity recovery is a separate, explicitly authorized protocol; unreadable or missing current state never enters or weakens the general restore classifier. `osi-db-integrity` can only publish the non-authorizing latch. The ordinary controller may enter closed phases `integrity-recovery-preparing -> integrity-recovery-invalidated -> integrity-database-quarantined -> integrity-database-restored -> integrity-reconciliation-required -> integrity-historical-dispositioning -> integrity-historical-clear|integrity-historical-blocked -> integrity-reconciled -> integrity-health-authorized -> integrity-finalizing` only through an explicit recovery invocation that names the latched request, one journal-bound trusted backup, and an acknowledgement that current canonical data may be unrecoverable. `scripts/database-integrity-recovery.js` and the shared capability helper are the only parsers/mutators. An exact valid existing four-root state uses its current heads. Exact all-root absence on a legacy gateway may use the one-use integrity initialization branch described above; malformed or partial roots cannot. No trusted backup, changed request, or absent explicit authority returns `FORWARD_REPAIR_REQUIRED|REJECTED` without touching the database or protocol state.

Under all four physical-root locks and the deployment lease, `prepare-integrity-recovery` verifies the exact missing/failed/timeout/unreadable observation, explicit authority, the same-operation database-lineage invalidation receipt or exact legacy not-applicable discriminator, selected backup manifest/size/hash/quick-check/audits, stopped roles/links, and either unchanged valid activity/capability heads or the journal-bound all-root absence fact. In the absence branch it creates/fsyncs capability, capability-witness, activity-database, and external activity-head genesis under the same operation, leaves historical v2 `UNASSESSED`, and then appends integrity invalidation; a crash may resume only this exact prefix. In the existing branch it appends from the verified heads. In both branches it fsyncs a distinct `DATABASE_INTEGRITY_INVALIDATION` generation, typed receipt, witness, and head before any main/WAL/SHM/journal move. The recovery adapter then renames the observed SQLite set into an operation-private root-owned forensic directory without deletion, records exact absent members for a missing database, restores only the selected backup, and requires repeated command and whole-database audits equal to that backup. It cannot publish a live-health permit: the protocol remains `databaseRestore.status:'RECONCILIATION_REQUIRED'` and the original latch remains until explicit reconciliation completes

Completion requires a second explicit reconciliation authority. `IMPORT_RECOVERED_ROWS` binds the exact recovered-row dataset and family adapters; `ACCEPT_BACKUP_CUTOFF` requires unchanged preexisting activity, capability, identity/reset/disposition, and writer witnesses, so ambiguous effects or identity drift cannot be acknowledged away. After import or cutoff evidence is final, the controller CASes to `integrity-historical-dispositioning`. An all-root initializer invokes the explicitly extended `record-v2-disposition` on the restored audit and reaches `integrity-historical-clear` only for a typed CLEAR receipt; quarantine/malformed reaches `integrity-historical-blocked`. Existing-root recovery produces the fresh revalidation receipt and may CAS clear only when the retained capability state and final audit agree. Before `complete-integrity-recovery`, every clear branch produces a fresh stopped final-database command audit and a historical revalidation receipt. Import always uses `FRESH_FINAL_DATABASE`; an all-root initializer also runs the normal stopped disposition to CLEAR. Cutoff alone may use `RETAINED_BACKUP_CLEAR`, and only when final command audit equals the backup audit, the retained CLEAR receipt still cross-matches that audit/identity, and the command/capability cutoff proof is exact. Any reintroduced/unscoped/malformed row or stale CLEAR stays blocked. Only from `integrity-historical-clear`, the completion verb verifies the revalidation, final audits, zero effect/transport calls, forensic/source graphs, activity/capability/writer roots, lineage receipt, and epoch, then appends `DATABASE_INTEGRITY_RECONCILED`. The controller writes the resolution and CASes to `integrity-health-authorized` while retaining latch/lease. The existing guarded-launch permit path runs the selected runtime once in read-only integrity-probe mode with sync, pending commands, MQTT, ChirpStack, schedulers, local APIs, and database writes disabled; after GUI/API/database checks it stops and fsyncs health evidence. Only then are recovery/topology receipts fsynced. The controller first stable-copies/fsyncs the exact latch bytes into the recovery directory and publishes the request-removal intent, then CASes the existing `activeSubOperation.kind:'recovery'` to phase `integrity-finalizing` with lease retained and all request-copy/resolution/health/recovery/topology hashes bound. `finalize-integrity-recovery` idempotently removes and parent-fsyncs only the matching latch, writes the latch-removal receipt, and then the final `recovered` CAS binds that receipt while clearing lease/sub-operation. A crash after unlink but before receipt/CAS resumes from the exact finalizing tuple with all roles still inhibited; normal startup begins only after final CAS. Failure or crash before terminal CAS keeps latch/lease. A consumed health permit is never replayed: retry uses the next monotonic health-attempt/state-permit generation only after the prior process is absent and a durable retry proof shows identical database/audit/capability/activity facts plus zero mutation/egress counters; uncertainty remains blocked. No backup-only restore, acknowledgement, shell success, reconciled generation, or prior CLEAR alone is health authority.

All integrity objects are unknown-field-rejecting and use the same canonical hash/path/time rules. Every SHA field below must resolve to the named exact-path object and cross-match request, recovery operation, restore epoch, backup, observation, lineage, activity, and capability facts; hashing arbitrary bytes never satisfies authority:
- Observed evidence at `/data/osi-deploy/database-integrity-recoveries/<request-id>/observed-evidence.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_OBSERVATION',requestId,recoveryRequestSha256,databasePath:'/data/db/farming.db',observedDatabaseIdentitySha256,quickCheckResult:'missing'|'failed'|'timeout'|'unreadable',sqliteMembers:[{name:'main'|'wal'|'shm'|'journal',path,status:'ABSENT'|'PRESENT',device,inode,sizeBytes,sha256}],bootIdSha256,createdAt}`. It has exactly four sorted members. ABSENT requires null device/inode/size/hash; PRESENT requires safe values and a hash from a stable lstat/read/lstat. `missing` requires only the main member ABSENT; WAL/SHM/journal are independently ABSENT or PRESENT and every present orphan is preserved.
- Possible-loss acknowledgement at `possible-data-loss-acknowledgement.json` is exactly `{format:1,kind:'POSSIBLE_DATA_LOSS_ACKNOWLEDGEMENT',requestId,recoveryOperationId,backupManifestSha256,observedEvidenceSha256,acknowledgement:'CURRENT_CANONICAL_DATA_MAY_BE_UNRECOVERABLE',actorPrincipalSha256,authorizedAt}`. Only an explicit controller invocation may create it; stdin/default/empty actor cannot satisfy it.
- Forensic inventory at `forensic-inventory.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_FORENSIC_INVENTORY',requestId,recoveryOperationId,restoreEpoch,observedEvidenceSha256,members:[{name:'main'|'wal'|'shm'|'journal',status:'ABSENT'|'PRESERVED',forensicPath,sizeBytes,sha256}],createdAt}`. It has exactly four sorted entries: ABSENT cross-matches an absent observation and null path/size/hash; PRESERVED cross-matches a present observation byte-for-byte at an operation-private nonsymlink path.
- Adapter inventory at `reconciliation-adapters.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_ADAPTER_INVENTORY',implementationManifestSha256,adapters:[{adapterId,family:'device_data'|'journal'|'configuration'|'sync_outbox'|'sync_inbox'|'sync_cursor'|'command_state',fromSchemaSha256,toSchemaSha256,sourceTables,targetTables,implementationId,codeSha256}],createdAt}`; adapters are sorted/unique, source/target table arrays are nonempty sorted/unique, every imported family/schema tuple has exactly one, and each implementation ID/path/hash cross-matches the artifact-owned recovery implementation manifest.
- Artifact trust roots at `manifests/database-integrity-source-trust-roots.json` are exactly `{format:1,kind:'DATABASE_INTEGRITY_SOURCE_TRUST_ROOTS',keys:[{keyId,algorithm:'Ed25519',publicKeyPath,publicKeySizeBytes:32,publicKeySha256,validFrom,validUntil}]}` with a nonempty sorted unique key set and bounded nonoverlapping validity. Every key path names an exact artifact-owned mode-0644 raw 32-byte Ed25519 public-key file under `trust/database-integrity/`; missing/orphaned/extra/wrong-mode keys fail. Source verification at `source-verification.json` is exactly `{format:1,kind:'SIGNED_EXPORT_VERIFICATION',sourceArtifactPath,sourceArtifactSizeBytes,sourceArtifactSha256,signaturePath,signatureSizeBytes:64,signatureSha256,signatureAlgorithm:'Ed25519',keyId,trustRootManifestSha256,publicKeySha256,verifiedGatewayDeviceEui,issuedAt,expiresAt,verifiedAt}`. Artifact/signature paths are operation-private root-owned mode-0600 regular nonsymlinks. On creation and every consume/resume the helper stable-reads their exact sizes/hashes, loads the manifest-selected 32-byte public key, reruns Ed25519 verification over the source bytes, and checks validity window/gateway. A forged verification JSON, changed source/signature/key, unsigned/expired/wrong-gateway/untrusted-key/live-fetch/production artifact is rejected.
- Cloud comparison at `cloud-comparison.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_CLOUD_COMPARISON',requestId,recoveryOperationId,restoreEpoch,gatewayDeviceEui,sourceKind:'SIGNED_EXPORT',sourceIdentitySha256,sourceArtifactSha256,sourceVerificationSha256,backupManifestSha256,families:[{family:'device_data'|'journal'|'configuration'|'sync_outbox'|'sync_inbox'|'sync_cursor'|'command_state',backupHighWatermark,sourceHighWatermark,backupRowSetSha256,sourceRowSetSha256,missingRangeStart,missingRangeEnd}],createdAt}`. It contains all seven sorted families; nullable ranges are both null only when row sets/high-watermarks prove no gap. The source artifact must match the signed-export verification object. Production access is not implied or authorized.
- Recovered-row data is the root-owned mode-0600 SQLite file `recovered-rows.sqlite` with `journal_mode=DELETE`, `quick_check=ok`, no sidecars, and the sole table `recovered_rows(family TEXT NOT NULL, source_table TEXT NOT NULL, stable_key BLOB NOT NULL, source_schema_sha256 TEXT NOT NULL, codec_version INTEGER NOT NULL CHECK(codec_version=1), canonical_row BLOB NOT NULL, row_sha256 TEXT NOT NULL, PRIMARY KEY(family,source_table,stable_key)) WITHOUT ROWID`. `canonical_row` uses codec version 1 of the whole-database audit's type-tagged length-prefixed row format; `row_sha256` hashes family, source table, stable key, source schema, codec, and row bytes. Its exact `recovered-rows.manifest.json` is `{format:1,kind:'DATABASE_INTEGRITY_RECOVERED_ROWS',requestId,recoveryOperationId,restoreEpoch,datasetPath,datasetSizeBytes,datasetSha256,sqliteSchemaSha256,sourceVerificationSha256,sourceArtifacts:[{kind:'FORENSIC'|'SIGNED_EXPORT',sha256}],families:[{family,tables:[{sourceTable,sourceSchemaSha256,codecVersion:1,rowCount,rowSetSha256}]}],createdAt}`. Paths are operation-private, sources/families/tables sorted/unique, every row cross-matches its table entry, and the manifest repeats a stable read/hash after close.
- Offline import manifest at `offline-import-manifest.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_OFFLINE_IMPORT_MANIFEST',requestId,recoveryOperationId,restoreEpoch,forensicInventorySha256,cloudComparisonSha256,adapterInventorySha256,recoveredRowsManifestSha256,families:[{family,adapterId,sourceSchemaSha256,codecVersion:1,sourceTables,targetSchemaSha256,inputRows,inputRowSetSha256,expectedOutputRows,expectedOutputRowSetSha256}],createdAt}`. Families exactly equal the nonempty recovered-row subset; source tables are sorted/unique and their rows/schema/codec equal the dataset; and each selected adapter's `fromSchemaSha256`, `sourceTables`, target schema, and implementation hash match exactly. The same row bytes under another table/schema/codec are different evidence and cannot be imported.
- Offline import receipt at `offline-import-receipt.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_OFFLINE_IMPORT_RECEIPT',requestId,recoveryOperationId,restoreEpoch,offlineImportManifestSha256,recoveredRowsManifestSha256,beforeCommandAuditSha256,beforeFarmingAuditSha256,afterCommandAuditSha256,afterFarmingAuditSha256,families:[{family,adapterId,inputRows,insertedRows,updatedRows,unchangedRows,outputRowSetSha256}],externalEffectCalls:0,ackTransportCalls:0,createdAt}`. Its family inputs and outputs equal the dataset/manifest expectations and final repeated audits.
- Command/capability cutoff proof at `command-activity-cutoff-proof.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_COMMAND_CAPABILITY_CUTOFF_PROOF',requestId,recoveryOperationId,restoreEpoch,backupManifestSha256,backupActivityGeneration,backupActivityEntrySha256,backupActivityExternalHeadSha256,preInvalidationActivityGeneration,preInvalidationActivityEntrySha256,preInvalidationActivityExternalHeadSha256,backupCapabilityGeneration,backupCapabilityHeadSha256,backupCapabilityWitnessSha256,preInvalidationCapabilityGeneration,preInvalidationCapabilityHeadSha256,preInvalidationCapabilityWitnessSha256,backupWriterGeneration,preInvalidationWriterGeneration,invalidationGeneration,invalidationReceiptSha256,invalidationPredecessorGeneration,invalidationPredecessorHeadSha256,invalidationPredecessorWitnessSha256,observedLiveCapabilityGeneration,observedLiveCapabilityHeadSha256,observedLiveCapabilityWitnessSha256,proof:'UNCHANGED_BACKUP_TO_PRE_INVALIDATION_AND_EXACT_INVALIDATION_DESCENDANT',createdAt}`. Backup equals the preparation intent's pre-invalidation activity/capability/identity/mode/reset/disposition/writer facts. The invalidation receipt predecessor equals those capability facts, and the observed live chain must end exactly at that integrity invalidation generation/head/witness with no unrelated advance. All-root absence/new genesis, backup-to-pre-invalidation drift, wrong predecessor, extra generation, identity/reset drift, activity/writer drift, or missing backup witness cannot authorize cutoff.
- Accepted loss boundary at `accepted-loss-boundary.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_ACCEPTED_LOSS_BOUNDARY',requestId,recoveryOperationId,restoreEpoch,backupManifestSha256,forensicInventorySha256,cloudComparisonSha256,commandCapabilityCutoffProofSha256,lossWindowStart,lossWindowEnd,affectedFamilies,acknowledgement:'ACCEPT_BACKUP_CUTOFF',actorPrincipalSha256,reasonSha256,authorizedAt}`. The sorted nonempty families and UTC loss interval exactly cover every unresolved non-command comparison gap; an importable or no-gap family cannot be acknowledged away, and command state is legal only through the unchanged existing-witness proof.
- Authority at `/data/osi-deploy/database-integrity-recoveries/<request-id>/authority.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_RECOVERY_AUTHORITY',requestId,recoveryOperationId,recoveryRequestSha256,backupManifestSha256,backupDatabaseSha256,observedEvidenceSha256,possibleDataLossAcknowledgementSha256,databaseLineageInvalidationReceiptSha256,disposition:'RESTORE_TRUSTED_BACKUP_AND_RECONCILE',createdAt}`. The lineage field is null only for an exact legacy `not-applicable` parent; otherwise it names the same-operation `database-integrity-recovery` lineage invalidation receipt.
- Preparation result common fields are exactly `{format:1,kind:'DATABASE_INTEGRITY_RECOVERY_PREPARATION_RESULT',requestId,recoveryOperationId,recoveryRequestSha256,authoritySha256,observedEvidenceSha256,databaseLineageInvalidationReceiptSha256,createdAt}`. `BACKUP_REPLACEMENT_PREPARED` adds only `{result,protocolInitialization:'EXISTING'|'CREATED_FROM_ALL_ABSENT',restoreEpoch,backupManifestSha256,backupDatabaseSha256,backupCommandAuditSha256,backupFarmingAuditSha256,forensicDestination,activityGeneration,activityEntrySha256,activityExternalHeadSha256,invalidationGeneration,invalidationReceiptSha256,invalidationHeadSha256,invalidationWitnessSha256}`; `FORWARD_REPAIR_REQUIRED|REJECTED` add only `{result,reason,evidenceSha256}` with reason `NO_TRUSTED_BACKUP|PARTIAL_PROTOCOL_ROOT_STATE|REQUEST_CHANGED|BACKUP_INVALID|AUTHORITY_INVALID|LINEAGE_INVALIDATION_MISSING|FORENSIC_PATH_UNSAFE|MALFORMED_EVIDENCE`.
- Permanent `database-integrity-receipts/<restore-epoch>.invalidation.json` is exactly `{format:1,receiptKind:'database-integrity-invalidation',operationId,requestId,recoveryOperationId,restoreEpoch,recoveryRequestSha256,authoritySha256,observedEvidenceSha256,databaseLineageInvalidationReceiptSha256,observedDatabaseIdentitySha256,quickCheckResult:'missing'|'failed'|'timeout'|'unreadable',backupManifestSha256,backupDatabaseSha256,backupCommandAuditSha256,backupFarmingAuditSha256,forensicDestination,protocolInitialization:'EXISTING'|'CREATED_FROM_ALL_ABSENT',predecessorGeneration,predecessorHeadSha256,predecessorWitnessSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,createdAt}`.
- Reconciliation authority at `reconciliation-authority.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_RECONCILIATION_AUTHORITY',requestId,recoveryOperationId,restoreEpoch,disposition:'IMPORT_RECOVERED_ROWS'|'ACCEPT_BACKUP_CUTOFF',forensicInventorySha256,cloudComparisonSha256,offlineImportManifestSha256,recoveredRowsManifestSha256,acceptedLossBoundarySha256,commandCapabilityCutoffProofSha256,actorPrincipalSha256,authorizedAt}`. Import requires import/recovered manifests and null loss-boundary/cutoff hashes. Cutoff requires loss-boundary and exact command/capability cutoff proof with null import hashes. All referenced graphs close over the same observation, backup, gateway, request, identity, and epoch.
- Historical revalidation at `historical-revalidation-receipt.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_HISTORICAL_REVALIDATION',requestId,recoveryOperationId,restoreEpoch,proofKind:'FRESH_FINAL_DATABASE'|'RETAINED_BACKUP_CLEAR',backupCommandAuditSha256,finalCommandAuditSha256,priorHistoricalDispositionReceiptSha256,currentIdentitySha256,currentCapabilityGeneration,currentCapabilityHeadSha256,currentCapabilityWitnessSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,writerGeneration,historicalUnscopedRows,malformedRows,unknownRows,createdAt}`. Fresh requires a newly executed stopped audit, all three counters zero, and any required same-identity rebind/disposition receipt. Retained is cutoff-only and requires backup/final audit equality, the exact cutoff proof, unchanged identity/capability/activity/writer facts, and the prior CLEAR receipt to classify those same bytes.
- Permanent `database-integrity-receipts/<restore-epoch>.reconciled.json` is exactly `{format:1,receiptKind:'database-integrity-reconciled',operationId,requestId,recoveryOperationId,restoreEpoch,invalidationGeneration,invalidationReceiptSha256,reconciliationAuthoritySha256,historicalRevalidationReceiptSha256,databaseLineageInvalidationReceiptSha256,forensicInventorySha256,cloudComparisonSha256,offlineImportManifestSha256,recoveredRowsManifestSha256,offlineImportReceiptSha256,acceptedLossBoundarySha256,commandCapabilityCutoffProofSha256,postReconcileCommandAuditSha256,postReconcileFarmingAuditSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,externalEffectCalls:0,ackTransportCalls:0,predecessorHeadSha256,createdAt}`. Import disposition requires the import-manifest, recovered-row-manifest, and import-receipt hashes and null accepted-loss/cutoff hashes. Cutoff requires the reverse and the exact unchanged existing-witness proof. Both bind the same lineage receipt as preparation.
- Resolution at `/data/osi-deploy/database-integrity-resolutions/<request-id>.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_RESOLUTION',requestId,recoveryOperationId,restoreEpoch,recoveryRequestSha256,authoritySha256,invalidationReceiptSha256,reconciledReceiptSha256,reconciliationAuthoritySha256,historicalRevalidationReceiptSha256,historicalProofKind:'FRESH_FINAL_DATABASE'|'RETAINED_BACKUP_CLEAR',databaseLineageInvalidationReceiptSha256,forensicInventorySha256,backupCommandAuditSha256,postReconcileCommandAuditSha256,postReconcileFarmingAuditSha256,capabilityHeadSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,writerGeneration,createdAt}`. Import and root initialization require fresh proof. Retained proof is cutoff-only and repeats the exact audit/head/identity equality rules; it can never authorize imported/reintroduced historical rows.
- Integrity health identity at `/data/osi-deploy/database-integrity-recoveries/<request-id>/integrity-health-identity.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_HEALTH_IDENTITY',requestId,recoveryOperationId,parentGeneration,bootIdSha256,resolutionSha256,reconciledReceiptSha256,historicalRevalidationReceiptSha256,selectedReleaseManifestSha256,databaseIdentitySha256,commandAuditSha256,farmingAuditSha256,capabilityHeadSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,createdAt}`. It is immutable identity input, not a start capability. Existing `issue-probe-permit --purpose integrity-recovery-health --integrity-health-identity <path> --health-attempt-generation <n> --nonce-out <path>` verifies it, stores its hash/attempt generation in the state permit, and emits only the standard generation-specific nonce.
- Health-attempt intent at `health-attempts/<zero-padded-generation>.intent.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_HEALTH_ATTEMPT',requestId,recoveryOperationId,healthAttemptGeneration,previousAttemptSha256,priorRetryProofSha256,integrityHealthIdentitySha256,statePermitSha256,nonceSha256,bootIdSha256,createdAt}`. Under the deployment-state lock, the guarded launcher CASes the existing permit from active to a durable consumed state that records `{healthAttemptGeneration,intentSha256,nonceSha256,processGeneration,consumedAt}`; that canonical state generation/hash is the consumed tombstone. Nonce unlink and parent fsync are idempotent cleanup after the CAS. A crash before the CAS may resume the same active permit. After CAS, only the same uninterrupted launcher invocation may unlink/fsync the nonce, prove absence, and exec; any crash or return burns that generation, performs nonce cleanup only, and can proceed solely through a new generation after retry proof. No separate tombstone file or multi-file atomic claim exists.
- If a consumed attempt has no PASS receipt, retry proof at `health-attempts/<generation>.retry-proof.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_HEALTH_RETRY_PROOF',requestId,recoveryOperationId,healthAttemptGeneration,intentSha256,consumedStateGeneration,consumedStateSha256,nonceCleanupConfirmed:true,processGeneration,processAbsent:true,commandAuditSha256,farmingAuditSha256,databaseIdentitySha256,capabilityHeadSha256,activityGeneration,activityEntrySha256,activityExternalHeadSha256,syncRequests:0,pendingCommandRequests:0,mqttPublishes:0,chirpstackCalls:0,schedulerRuns:0,localApiMutations:0,databaseWrites:0,result:'SAFE_TO_RETRY',createdAt}`. Only exact equality with the immutable health identity may CAS to the next generation and issue a new permit. Missing counters, remaining nonce, live/ambiguous process, changed audit/head, reboot without proof, or prior PASS forbids retry.
- Health receipt at `/data/osi-deploy/database-integrity-recoveries/<request-id>/health-receipt.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_HEALTH_RECEIPT',requestId,recoveryOperationId,healthAttemptGeneration,attemptIntentSha256,consumedStateGeneration,consumedStateSha256,statePermitSha256,integrityHealthIdentitySha256,resolutionSha256,selectedReleaseManifestSha256,databaseIdentitySha256,commandAuditSha256,farmingAuditSha256,guiProbe:'PASS',apiProbe:'PASS',databaseProbe:'PASS',syncRequests:0,pendingCommandRequests:0,mqttPublishes:0,chirpstackCalls:0,schedulerRuns:0,localApiMutations:0,databaseWrites:0,processStopped:true,result:'PASS',createdAt}`. It is O_EXCL per recovery operation; recovery/topology receipts and finalization bind its successful generation/hash. No failed/partial receipt is acceptable.
- Before finalizing, canonical request copy at `recovery-request.canonical.json` is a byte-for-byte root-owned mode-0600 stable copy of the still-present latch. Request-removal intent at `request-removal-intent.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_REQUEST_REMOVAL_INTENT',requestId,recoveryOperationId,recoveryRequestSha256,canonicalRequestCopyPath,canonicalRequestCopySha256,resolutionSha256,healthReceiptSha256,topologyActivationReceiptSha256,recoveryReceiptSha256,createdAt}`; both files and parent are fsynced before the finalizing CAS.
- The finalizing active sub-operation stays inside the closed recovery union and is exactly `{kind:'recovery',phase:'integrity-finalizing',operationId,requestId,recoveryRequestSha256,requestRemovalIntentSha256,canonicalRequestCopySha256,resolutionSha256,healthReceiptSha256,topologyActivationReceiptSha256,recoveryReceiptSha256,latchRemovalReceiptSha256:null}` with `leaseActive:true`; its parent generation and hashes are immutable until the final CAS. Unknown/extra/missing facts or a different latch path cannot finalize.
- Latch-removal receipt at `/data/osi-deploy/database-integrity-recoveries/<request-id>/latch-removal-receipt.json` is exactly `{format:1,kind:'DATABASE_INTEGRITY_LATCH_REMOVAL',requestId,recoveryOperationId,finalizingParentGeneration,recoveryRequestSha256,requestRemovalIntentSha256,canonicalRequestCopySha256,resolutionSha256,healthReceiptSha256,topologyActivationReceiptSha256,recoveryReceiptSha256,latchPath:'/data/osi-deploy/database-recovery-required.json',latchRemoved:true,parentFsynced:true,removedAt}`. It is legal only in `activeSubOperation.kind:'recovery', phase:'integrity-finalizing'` with lease active. If the latch is already absent after a crash, the immutable canonical request copy plus exact intent/finalizing state authorize deterministic receipt completion; any mismatch remains blocked. Terminal `recovered` binds this receipt and is the sole lease-release edge.

Tests cover missing main, corrupt/timeout/unreadable main with every sidecar combination, valid-existing and legacy all-root-absence initialization, no trusted backup, tampered backup/authority/request/root/lineage receipt, and every invalidation/forensic/restore/audit/reconciliation/resolution/permit/health/terminal-CAS/unlink crash prefix. Codec tests mutate every integrity object/field and cross-branch null rule. Dataset tests change bytes/path/size/schema/signature/trust root, add/remove/duplicate/reorder rows, switch source after preparation, drift adapter implementation, and resume from a changed manifest. Cutoff tests require the unchanged preexisting witness and reject all-root absence, new genesis, backup-to-pre-invalidation activity/capability/writer drift or any capability generation beyond the exact integrity invalidation, identity/reset drift, ambiguous effect state, or an affected command family. Historical tests cover the all-root integrity disposition subphase, existing-root fresh revalidation, retained cutoff proof, stale CLEAR, imported/reintroduced unscoped rows, quarantine, and every clear/blocked crash prefix. Probe tests attempt sync, pending poll, MQTT, ChirpStack, scheduler, API and SQLite writes, respawn, wrong latch, and permit replay, consume-before-start, consume/start-before-receipt, safe next-generation retry, and ambiguous retry; mutation counters remain zero and only the proved retry advances. Every prefix preserves forensic bytes and stays inhibited or reaches health receipt -> recovery/topology receipts -> integrity-finalizing CAS -> latch unlink/fsync -> removal receipt -> terminal CAS/lease release in that exact order; a restored backup or integrity-reconciled head alone is never startup authority.

`invalidate-v2-disposition` is deliberately narrower: it requires a committed prior CLEAR plus the linked recovery phase, immutable preparation result, restore receipt, restored-database audit, identity, and current heads, then appends a typed `RECONCILIATION_REQUIRED` generation before topology/startup can be authorized. It never deletes or rewinds that CLEAR generation and is never called for `NO_CLEAR|REJECTED`. `authorize-reset` consumes the A0 guard evidence: identityd and Node-RED are absent, bootstrap/database-integrity one-shot children are absent, every rc link plus exact-present guard-aware `94_osi_identityd_enable` is quarantined, the identityd lock is absent, and stable sentinel/request/completion facts have an explicit terminal reconciliation disposition. It verifies backup and all-protocol ACK-audit identities before CAS. A merged identity restart or relink followed by sentinel removal never authorizes capability identity drift: polling stays blocked until this exact reset transaction succeeds, after which normal gateway-migration preflight may run. Direct CLI tests spawn every verb, both old-phase initialize forms, factory-only invocation, every restore-preparation branch/resume/crash, out-of-band disposition/invalidation, and every mutation negative; importing the module without command dispatch cannot pass.

Extend the Train A artifact builder/verifier in this same task to include `scripts/audit-command-ack-state.js`, its both-profile ROM-bound copies, `scripts/audit-farming-database-state.js`, `scripts/seal-database-restore-baseline.js`, `scripts/database-integrity-recovery.js`, `scripts/manifests/database-restore-reverse-adapters.json`, `scripts/manifests/database-recovery-implementations.json`, `scripts/manifests/database-integrity-source-trust-roots.json`, every manifest-enumerated `scripts/trust/database-integrity/*.ed25519.pub` public key, `scripts/reconcile-command-ack-state.js`, their complete dependency closures, `scripts/sync-protocol-capability-cli.js`, its both-profile ROM-bound copies, the complete selected-profile `osi-sync-protocol-state` helper/package dependency closure, and the exact deployment-state library/CLI parser dependencies. `scripts/verify-command-activity-witness.js` remains a source-tree CI/build gate and is deliberately excluded from the live deployment artifact. The image/control manifests and factory provenance bind the ROM audit/protocol/helper hashes used by `complete-image-baseline`. Run every live CLI from an otherwise empty working directory and delete each executable/dependency in turn; ambient repository or ROM files cannot satisfy it. Extend `backup-pre-deploy.sh` to record all-root pre-initialization absence or exact lstat/highest-generation/head/checkpoint identities without restoring them. Artifact/profile/provenance tests remove each factory, disposition-restore, general database-restore, integrity-recovery, baseline-seal, whole-database audit, merge, completion dependency, ROM copy, manifest entry, audit/source/preparation schema, activity adapter edge, and shared parser/lock export in turn.

After mirroring and source-to-resident verification, refresh the complete factory trust bundle with `node scripts/generate-factory-image-provenance.js --refresh-bound-hashes --preserve-image-build-id --write`. The generator first reads both committed format-2 provenance records, rejects missing/different profile or build-ID relation, constructs both image-guard manifests and both provenance records entirely in memory from the source plus resident audit/protocol/helper bytes, validates all four candidates through the shared codec, then atomically replaces the two manifests before their dependent provenance records. It never invents or changes an image build ID in refresh mode. Immediately run the non-writing `--refresh-bound-hashes --preserve-image-build-id --check`, semantic provenance verifier/tests, source↔both-resident/profile parity tests, built-rootfs verifier tests, and image-guard boot test. Stale anchor, source-only or one-resident change, same-change-to-both-residents without source, missing ROM entry, wrong write order, partial four-file refresh, or build-ID drift fails. Stage the modified sources, all resident copies, and all four regenerated anchors together; no sync slice may leave the A0 trust bundle stale.

Before `arm`, `backup-pre-deploy.sh` creates a distinct purpose-specific `/data/db/backups/<attempt>/command-ledger/pre-disposition.db` from the stopped live farming database using SQLite online `.backup`; it requires root ownership/mode 0600, `PRAGMA quick_check = ok`, file/parent fsync, and exact size/SHA256. The final backup manifest binds it under `commandLedgerPreDispositionBackup` with deployment, audit, database inode/schema, all three persistent chain heads, guarded writer generation, and target identity facts. It is not `database_backup_path` and cannot be selected for migration or general rollback. The general farming backup independently binds the same decisive audit, command-activity generation/head, capability generation/head/witness, writer generation, database identity, and full command/domain row-set hashes used by `prepare-database-restore`. `restore-pre-deploy.sh --purpose command-ledger-disposition --state ... --recovery-operation-id ... --backup-manifest ... --expected-path ... --expected-size ... --expected-sha256 ... --restore-preparation-result ...` accepts the purpose image only while all writers/links remain stopped and the exact parent plus linked recovery proves a disposition mutation occurred before first new-runtime start. Before shell touches the database, it invokes the manifest-owned `prepare-disposition-restore` CLI and consumes only its immutable, hash-bound result; shell never loads, classifies, or completes capability files.

For `NO_CLEAR`, the restore script restores and audits the database, binds the observed no-CLEAR heads, preparation result, and restore audit in the deployment recovery receipt, retains the current `UNASSESSED|RECONCILIATION_REQUIRED` polling block, and does not call `invalidate-v2-disposition`. `UNHEADED_CLEAR_COMPLETED` proves the helper finished the existing typed receipt/witness/head from unchanged pre-restore source facts; shell then restores/audits and calls invalidation with that result. `COMMITTED_CLEAR` restores/audits first and calls invalidation. `REJECTED` or CLI failure blocks before restore or start. Wrong general/migration path, missing purpose/result field, post-start state, changed audit/identity, or a crash at preparation intent, DB commit, generation, typed receipt, witness, head, result, restore, audit, or applicable invalidation resumes only its same recovery ID and exact branch. Direct CLI and backup/restore tests use different valid SQLite contents at all three paths, prove only this purpose-bound image is consumed, cover already-completed same-recovery resume, and delete or alter the preparation call/result so shell-only classification cannot pass.

General rollback uses a different exact form: `restore-pre-deploy.sh --purpose general-database-restore --state ... --recovery-operation-id ... --backup-manifest ... --restore-baseline ... --expected-path ... --expected-size ... --expected-sha256 ... --database-restore-preparation-result ...`. It must invoke `prepare-database-restore` before the first SQLite-set mutation and accept only its immutable result. `NO_POST_BACKUP_DATABASE_DELTA` or `EXPECTED_DEPLOYMENT_MUTATION_ONLY` may restore, rerun both audits for exact equality with the backup, and proceed without a protocol generation only while all bound roots and writer generations remain unchanged. `RECONCILIATION_REQUIRED` may restore only after the invalidation generation/head is committed, then remains stopped through the migration-version-aware snapshot merge and `complete-database-restore-reconciliation`. `REJECTED`, missing current evidence/baseline, non-command post-baseline delta, expected-mutation mismatch, or any helper failure performs zero restore/start actions. Purpose-specific and general preparation results are different closed schemas and paths; neither script mode accepts the other's backup, result, receipt, or phase. Direct tests remove each CLI call, swap result types, advance only the activity witness, roll back only `activity.sqlite`, change only a delivered ACK or command domain postcondition, exercise schema-only, migration-ledger, data-backfill, and new-table deployment mutations both alone and followed by sensor/config writes, omit reverse merge adapters, corrupt the current database, inject every commit/baseline-seal/restore crash boundary, and prove no live `recovery-health` permit/start exists until the reconciled generation commits.

Integrity replacement uses only `restore-pre-deploy.sh --purpose database-integrity-recovery --state ... --request ... --authority ... --preparation-result ... --backup-manifest ... --forensic-destination ...`. It accepts only `BACKUP_REPLACEMENT_PREPARED` after the integrity invalidation head is durable, moves each present SQLite-set member to the absent forensic destination with file/parent fsync, restores/audits the selected journal-bound backup, and CASes only to `integrity-reconciliation-required`. `FORWARD_REPAIR_REQUIRED|REJECTED`, a general-restore result, untrusted `.bak-*`, missing invalidation, cross-request authority, changed source member, or any restore/audit failure performs no start or latch removal. Direct tests cover exact same-operation resume for every member/receipt boundary and prove neither shell exit zero nor backup equality can synthesize reconciliation.

The A0 factory-seed codec is the sole database-lineage authority. It creates root-owned mode-0600 `/data/osi-deploy/factory-database-lineage.json` exactly as `{format:1,databasePath:'/data/db/farming.db',seedReceiptSha256,seedSha256,createdDevice,createdInode,createdAt}` and defines `databaseLineageSha256` as the SHA256 of its canonical bytes. `verifyFactoryDatabaseLineage` rejects unknown fields, symlinks, wrong ownership/mode/path, changed seed receipt/hash, nonregular live DB, current device/inode mismatch, failed quick-check, or a non-valid journal lineage state. Ordinary SQLite writes, WAL checkpoints, online backups, and schema migrations that retain the main-file device/inode and valid state preserve lineage; raw DB bytes and `PRAGMA schema_version` are intentionally not lineage fields.

`parentDeployment.databaseLineage` is one exact nested state machine: `{status:'not-applicable'}`; `{status:'factory-pending',baselineId}`; `{status:'valid',databaseLineageSha256,seedReceiptSha256}`; `{status:'invalidating',databaseLineageSha256,operationId,reasonCode}`; or `{status:'invalidated',databaseLineageSha256,operationId,invalidationReceiptSha256}`. Unknown/cross-status fields fail. `initialize-image-baseline` creates factory-pending before seed mutation; after the seed receipt and lineage record fsync, it CASes that exact baseline to valid before the reboot-required prefix. Generic arm/startup/recovery reject factory-pending. Ordinary legacy parents use not-applicable only when no lineage record/receipt exists. Every `arm` or Train B parent replacement copies the prior valid/invalidated state exactly; a factory-derived state can never become not-applicable. Before any sanctioned restore, reseed, rebaseline, VACUUM/rekey that may replace the main file, or atomic main-file replacement, a leased deployment/recovery CASes exact `valid -> invalidating` with one operation ID and closed reason. It then O_EXCL-writes/fsyncs `/data/osi-deploy/receipts/<operation-id>.database-lineage-invalidation.json` exactly as `{format:1,receiptKind:'database-lineage-invalidation',operationId,parentDeploymentId,parentGeneration,priorDatabaseLineageStateSha256,databaseLineageSha256,reasonCode,createdAt}`, fsyncs the receipt directory, verifies its hash, and CASes `invalidating -> invalidated` before the DB mutation. No transition returns to valid; crash resume uses the same operation/receipt, and the mutation adapter rejects `valid|invalidating`. The factory seed receipt, factory-zero source/CLEAR receipts, terminal anchors, every decisive current audit/backup, and the direct-ready CAS all bind the same `databaseLineageSha256`; the protocol and deployment CLIs call this shared codec and shell never reconstructs the predicate. Tests mutate each lineage/state/receipt field, inject crashes around factory-pending/seed/valid, attempt factory-completed-to-armed not-applicable, replace the inode, simulate ordinary WAL/write/in-place migration preservation, inject crashes at both invalidation CASes/receipt/mutation, and require invalidation before every restore/reseed/replacement adapter.

Extend the deployment parent with `protocol-initializing -> protocol-dispositioning -> protocol-ready|protocol-reconciliation-required` after the final audit/backup-bound `arm` and before any runtime behavior write. `deploy.sh` may take the direct stopped-writer `protocol-ready` CAS without allocating an operation in exactly two cases: the paired backup plus all three complete live chains prove receipt-bound CLEAR, `databaseRestore.status:'CLEAR'`, and current-identity NEGOTIATED; or a verified factory `completed` tuple, intact capability/witness/activity anchors, exact `databaseLineageSha256`, and current decisive audit derive `factoryDirectReadyEligible:true` with null active identity and UNNEGOTIATED mode. Unrelated local data may have changed; raw database byte equality to the seed is not required. Otherwise it CASes to `protocol-initializing`, runs/revalidates capability/activity initialization, then CASes to `protocol-dispositioning` with one fsynced disposition operation ID and exact audit/backup/identity hashes. It spawns exactly one reviewed reconciliation mode: `record-zero`, `rebind-historical-v2`, or blocking `quarantine-historical-v2`. It verifies the source receipt, calls `record-v2-disposition`, and rereads all complete chains. Only `CLEAR` plus database-restore CLEAR may CAS `protocol-ready`; `RECONCILIATION_REQUIRED` CASes the blocking phase, leaves all roles stopped/owned, and routes to reviewed recovery. A crash before/after rebind or either receipt resumes the same operation from journal/audit/backup/row hashes. After factory terminal or `protocol-ready`, CLEAR+UNNEGOTIATED permits negotiation only, and no command dispatch occurs until its `NEGOTIATED` generation commits/reverifies and the activity chain is valid. Artifact omission, pre-arm or runtime initialization/disposition, factory tuple/lineage/command-audit drift, overwrite of a generation, chain restore/removal, changed CLI argv, start from UNASSESSED/RECONCILIATION_REQUIRED or a database-restore block, or dispatch from UNNEGOTIATED fails real deploy tests.

- [ ] **Step 1: Preserve the batch correlation map**

For this task, `cs-reg-cloud-ack-fn` is the current registration producer under test. The later ChirpStack reconciliation slice atomically transfers completion to `cs-reg-cloud-fn`, makes `cs-reg-cloud-ack-fn` wake-only, and updates, runs, and stages this same producer inventory in that commit; the two roles may never coexist as producers. Both `applied_commands.command_id` and `command_ack_outbox.command_id` use the exact stable internal outcome key `cloud:<identitySha256>:<transportCommandId>` for new v2 and v3 deliveries, while each outbox payload/provenance separately binds `ackProtocol` and current token when v3. Transport `commandId` remains the original integer and v2 wire bytes remain compatible. Every effect-key lookup requires the same capability `identitySha256` from validated ledger provenance in addition to `effect_key + command_type`; neither another identity nor historical unscoped v2 rows may satisfy it before disposition. Audit, grouping, supersession, and reconciliation resolve through that key and transport provenance; their parsers classify historical unscoped v2 keys separately and reject malformed/cross-identity forms. Every historical terminal/effect/reference row blocks polling at initialization until it is completely rebound to the current `cloud:` key or quarantined in `RECONCILIATION_REQUIRED`. Add v2→v3 same-origin same-ID lost-response replay, old-v2 identity -> reset -> new-v2 same numeric ID, pending-old-v2-ACK, and different-command-ID/same-effect-key/two-identity negatives.

Inventory every reader and writer of `applied_commands.command_id` and `command_ack_outbox.command_id`, not only flow producers. Export one contract from `osi-command-ledger`: `identityFromContext(context) -> {internalKey,transportCommandId,identitySha256,protocol}`, strict `parseInternalKey`, and transport-ID projection. `internalKey` is protocol-stable `cloud:<identitySha256>:<transportCommandId>`; protocol remains mandatory transport provenance and cannot be inferred from the key. The three `osi-journal` modules must use the contract for `persistedAck`, `persistFailure`, and `recordTerminalCommand`; every cloud journal principal carries protected identity/protocol context and never derives storage identity from the raw delivery ID. Local journal/operator commands use explicit `local:<opaque-id>`; only pre-upgrade v2 rows remain historical-unscoped until disposition. Valve expectations store the internal key and API/GUI responses project only public transport/local ID through the parser. Update both profiles and direct journal command/lifecycle/API and valve outcome suites with local, historical-unscoped v2, scoped same-identity v2→v3 replay, and identity-crossing cases.

Both `sync-pending-build` scheduled polling and `sync-force-build` manual/internal force-sync polling use the same sentinel-first capability decision, strict v3 parser, current lease-token provenance, and protected ledger context. Preserve their existing gateway-migration preflight bodies. Add scheduled/force cases for missing, present, malformed, unreadable, and unavailable-`fs` sentinel state; pre-pin v2 fallback; v3 pin; identity restart/relink followed by sentinel removal; and attempted post-pin downgrade. No parallel sentinel reader or capability shortcut is allowed.

For valve outcomes, every new cloud `valve_actuation_expectations.command_id` stores the same protocol-stable `cloud:` key so its join remains exact. The response query selects it only as `ledger_command_id`, joins `applied_commands` on that key, and projects public transport command ID through strict parser/result provenance; it never exposes the namespaced key. Historical unscoped v2 expectation/ledger references must be atomically rebound with their terminal/effect row before polling; partial or ambiguous sets enter `RECONCILIATION_REQUIRED`. Update writer, outcome query/mapper, rebind transaction, and executable tests for pending/applied/failed v2/v3 transport rows, v2→v3 redelivery without a second actuation, historical v2 display before disposition, same numeric ID under two identities, and GUI/API status. `scripts/verify-command-ledger-consumers.js` owns the complete SQL/module/rebind consumer inventory with remove-one, partial-rebind, and raw-ID-join negatives, runs directly in CI, and is pinned by `scripts/test-ci-guard-wiring.js`. No unreviewed reader may compare a transport ID directly with an internal key.

Parse each `command_ack_outbox` row once. In that same loop, keep the row ID beside its successfully parsed ACK and normalize according to its protected protocol. The later OSI OS half of `2026-07-15-cross-repo-sync-contract-ci.md` records the v3 bytes as the edge-owned fixture and tests this production mapping; the runtime flow does not load a test fixture. V3 has exactly nine outgoing keys: `commandId` (positive `Number.isSafeInteger`, maximum `9007199254740991`), `status` (string), `detail` (string|null), `result` (string|null), `appliedAt` (ISO-8601 string|null), `appliedSyncVersion` (`null` or `Number.isSafeInteger` in `0..9007199254740991`), `duplicate` (Boolean), `reason` (string|null), and server-issued `leaseToken` (UUID string). Local aliases are accepted only before persistence; the persisted/outgoing object is exact canonical camelCase. Reject extras, conflicting aliases, unsafe/negative/fractional numeric values, wrong types, invalid timestamps/UUIDs, or an absent key even when its allowed value is null. Serialize with the shared deterministic stable-key function and group v3 rows by command ID plus token. V2 rows retain their old serializer and endpoint in a separate batch. Tests pin 0, -1, maximum safe integer, `2^53`, and adjacent values that would collide after JS rounding for both numeric fields. A builder mutation that sends v3 bytes to v2, v2 bytes to v3, or combines protocols fails.

Audit and update every shipped ACK producer, not only the new validation path: `cdbaa3891d40d7a1`, `934bf2bc19a8ce22`, `e2e139678c3ddded`, `c8628cffe45f64f7`, `cs-reg-cloud-ack-fn`, `lsn50-mode-downlink-fn`, `command-dedupe-dispatch`, and `work-request-status-apply`. At pending split, derive a frozen `_commandLedgerContext` only from the protected envelope: capability `identitySha256`, gateway EUI, transport command ID/type, effect key, normalized payload hash, ACK protocol, and current lease token when v3. No payload-side field may override it. Internal outcome keys are exact `cloud:<identitySha256>:<transportCommandId>` for both protocols; only historical pre-upgrade v2 rows remain unscoped until disposition. The transport request still contains the unmodified safe integer `commandId`, never the namespaced key. This uses the existing TEXT primary key and requires no schema change. Each first terminal/retry case uses that context to enqueue the exact protocol-specific transport shape; command type, effect key, device EUI, capability identity, and effect state remain out-of-band. Same-identity v2→v3 redelivery finds the existing outcome, performs no effect, and creates only the protected v3 ACK generation with the server token. Add table-driven tests so removing one producer, losing/regenerating the current token, spoofing ledger facts in the payload, adding an extra transport key, mixing transport protocols, or delivering the same numeric ID under two capability identities fails. Terminal scoped rows from an old reset identity may coexist, but reset requires zero active old-identity v2/v3 outbox/intents and a new identity cannot dedupe against old-identity keys.

Make the ledger replay boundary canonical and generation-aware. `applied_commands.result_detail` stores a validated token-free domain outcome and local provenance, including capability identity hash for both protocols; it never makes ACK protocol or lease token part of historical effect truth. `replayAck()` resolves by the protocol-stable internal key but never spreads the stored object or appends `commandType`, `effectKey`, or capability identity to transport. For a v3 envelope, it requires the fresh current token from `_commandLedgerContext` and constructs the nine-field ACK with original integer transport command ID; for v2 it constructs the unchanged legacy transport shape. A same-identity v2 outcome redelivered through v3 performs no effect and receives only a fresh token-bound ACK projection. If a pending v3 outbox row already exists for the same capability identity, command ID, and token, validate and return those exact bytes without changing `duplicate`, timestamps, or any hash input. A new protected token atomically retires older-token pending v3 generations and creates one new ACK, normally with `duplicate:true`, from the stored outcome. HTTP retry preserves original protocol/token/bytes. Exact same-token, in-flight duplicate, v2→v3 lost-response replay, first v3 request dropped through lease expiry, new token, delayed old response, effect-key duplicate, same numeric ID across identities, and conflicting historical outcome are required tests. The new-token transaction leaves at most one pending v3 generation per identity/command; any other multi-transport ambiguity is reconciliation-required.

Add the read-only `audit-command-ack-state.js` preflight. Against an explicit database path, it validates pending ACK transports separately from token-free outcomes, retries, `INTENT_PERSISTED` effects, valve expectations, and every inventoried command-key reference; reports only IDs plus fixed classifications; and distinguishes identity-scoped `cloud:`, explicit `local:`, and historical-unscoped v2. A scoped terminal outcome is dedupe for the same protected identity across v2/v3 transport. Every unscoped terminal/effect/reference row—not only active outbox rows—blocks capability negotiation and command polling after upgrade.

The unknown-field-rejecting report exposes exact nonnegative counters: `scopedCloudTerminalOutcomeRows`, `scopedCloudNonterminalOutcomeRows`, `scopedCloudAckOutboxRows`, `scopedCloudRetryRows`, `scopedCloudExternalIntentRows`, `scopedCloudReferenceRows`, `historicalUnscopedTerminalRows`, `historicalUnscopedEffectRows`, `historicalUnscopedAckOutboxRows`, `historicalUnscopedRetryRows`, `historicalUnscopedReferenceRows`, `localOutcomeRows`, `localAckOutboxRows`, `localIntentRows`, `localReferenceRows`, `malformedCommandKeyRows`, `unknownProtocolRows`, `orphanCommandReferenceRows`, and `conflictingDuplicateRows`, plus canonical row-set, per-table, command-driven domain-postcondition, database, lineage, and command-activity state/generation/head hashes. The shared validator derives two Booleans; callers cannot supply them. `factorySeedEligible` requires every listed counter zero and exact `commandActivityState:'ABSENT_FACTORY_AUTHORIZED'`, proved against the second-boot baseline prefix before factory initialization creates the root. `factoryDirectReadyEligible` requires every counter except the four `local*` counters zero and a complete verified initialized command-activity chain, so legitimate local-only history may remain but any scoped cloud terminal row while active identity is null blocks. Both require `PRAGMA quick_check = ok`, exact database-lineage validation, and a stable repeated read under stopped writers. Tests set each counter to one independently, replace authorized absence with one-root/unauthorized absence, advance only the activity witness in initialized mode, mutate each per-table/domain hash without changing total counts, include delivered scoped ACK rows and terminal scoped cloud outcomes, and prove no broad `historical|active|malformed|unknown` alias can replace the closed predicate.

`reconcile-command-ack-state.js` owns stopped-writer, exact-live-database, fresh-backup-bound reconciliation modes. `rebind-historical-v2` requires a reviewed proof that the expected prior normalized origin/gateway/user identity equals the current capability identity and that every terminal outcome has complete consistent effect/result/reference provenance. Before mutation it writes/fsyncs a root-only immutable snapshot under the backup. In one SQLite transaction it rewrites the terminal row and every outbox, retry, intent, valve-expectation, journal, and inventoried reference from the old public ID to exact `cloud:<identitySha256>:<transportCommandId>`, preserving outcome/effect history, delivered/pending state, and v2 transport bytes; any collision, missing/extra/changed row, incomplete unsafe-effect provenance, or partial consumer inventory rolls back. It then writes/fsyncs an unknown-field-rejecting rebind receipt with database/backup/identity, before/after row-set hashes and counts, and transaction result. A zero-row audit produces the same typed clear receipt without mutation. `record-v2-disposition` verifies either receipt and advances to `CLEAR`.

If same-origin proof or complete rebind safety is unavailable, `quarantine-historical-v2` writes/fsyncs the full immutable backup-bound quarantine and disposition receipt but makes no delete/rewrite that could discard replay evidence; `record-v2-disposition` records only `RECONCILIATION_REQUIRED`, so all command polling remains blocked pending a later reviewed complete reconciliation. Separately, `quarantine-reset-active` requires the exact unexpired reset transition confirmation and old identity, snapshots all active old-identity v2/v3 transports/intents, then deletes exactly those still-matching active rows in one transaction; it never deletes terminal outcomes or another identity and cannot produce a historical-disposition receipt. Reset CAS still requires the follow-up zero-active-all-protocol/zero-unscoped audit. No mode sends an old ACK. Test upgrade terminal+no-outbox, terminal+falsely-delivered-outbox, lost response/redelivery through v2 and v3, unsafe valve/downlink effect, every reference table, collision/partial inventory, reset active-row quarantine, wrong identity/origin/backup/confirmation, crash before/after snapshot/transaction/receipt/head, historical quarantine still blocks, and empty DB; no producer/effect runs before `CLEAR`.

REST is the sole authoritative cloud-command ACK transport. Build an exact producer-branch reachability and effect-class inventory covering every terminal, retryable, permanent, expired, and replay output of `cdbaa3891d40d7a1`, `934bf2bc19a8ce22`, `e2e139678c3ddded`, `c8628cffe45f64f7`, `cs-reg-cloud-ack-fn`, `lsn50-mode-downlink-fn`, `command-dedupe-dispatch`, and `work-request-status-apply`. For SQLite-only families, the domain mutation, token-free ledger outcome, and token-bound outbox insert commit through one shared `osi-db-helper` transaction; the queue helper accepts the existing transaction and protected ledger context instead of opening a later database.

For every external RPC/downlink family, call `persistExternalIntent` before the first effect. It uses `db.durableTransaction`: serialize the shared connection, read and validate the exact current synchronous mode (`OFF|NORMAL|FULL|EXTRA`), set `PRAGMA synchronous=FULL` before `BEGIN IMMEDIATE`, insert the token-free `INTENT_PERSISTED` descriptor, commit, then restore the exact saved mode before releasing the queue. Begin/body/commit/rollback/restore failure leaves the facade blocked and emits no effect permission. Direct tests begin from `NORMAL`, `FULL`, and `OFF`, assert exact pragma order and prior-mode restoration on success and every failure, and require the facade to remain blocked when restoration itself fails. A child-process kill/reopen fixture proves the committed intent exists before the fake external-effect sentinel can run. Do not describe an ordinary `transaction()` under WAL `synchronous=NORMAL` as fsynced.

`persistExternalIntent` accepts only protected context plus `{effectClass,effectKind,effectKey,desiredStateHash}` and returns a bounded intent receipt. It stores no lease token, AppKey, prior external keys, or raw payload. `queueExternalIntentRetry` keeps that intent nonterminal, stores bounded retry metadata, and inserts the exact current-token retryable ACK in one transaction; same-token calls return its existing canonical bytes, while a fresh protected lease retires the prior transport generation and resumes the intent rather than replaying it as terminal. `completeIdempotentExternalEffect` opens one ordinary SQLite transaction, revalidates the matching intent/provenance, invokes a supplied parameterized local mutation on that transaction, rereads the local postcondition, writes the token-free terminal outcome, canonicalizes the exact current-token ACK, atomically supersedes older pending token generations, inserts the current outbox row, and commits. It returns only `{committed:true, commandId, outboxGeneration}`. No caller opens a nested transaction or builds/queues an ACK afterward.

Idempotent/read-back-capable effects such as ChirpStack reconciliation resume by checking desired external state from a matching protected redelivery. Same-process callback rejection may use the in-memory prior external snapshot for guarded compensation; after process death, the ledger never claims to retain prior secret keys and may only reread/converge the protected desired state or enter reconciliation-required. At-most-once effects such as timed valve/downlink actuation never resend after an ambiguous crash. The inventory declares each class and recovery proof.

After a completion transaction commits, a producer may emit one coalescible wake-only message to the REST ACK outbox scanner. Repurpose the existing `command-ack-queue-rest` node as this wake gate; despite its retained stable node ID, it no longer inserts or canonicalizes an ACK. The wake contains no ACK, token, command ID, or row ID and is not delivery evidence. A flush already in flight absorbs another wake; the existing 30 s scan recovers commit-before-wake crashes. Forbid a second queue transaction, MQTT completion edge, and post-return ACK construction. Add kill/fault injection after durable intent, external effect/read-back, local mutation, ledger update, outbox insert, commit, helper return, wake, and HTTP response for every producer class. Precommit faults roll back local mutation/completion/outbox together while retaining the intent; postcommit faults retain all three and never compensate. A replay performs no second SQLite mutation or unsafe actuation; remove-one, pre-transaction ACK, post-return queue, REST-plus-MQTT, and MQTT-only mutations fail.

Pin the edge-owned semantic pairs in the v3 HTTP contract fixture and producer table: `ACKED/APPLIED`, `NACKED/REJECTED_PERMANENT`, `EXPIRED/EXPIRED`, and `FAILED_RETRYABLE/FAILED_RETRYABLE`. No v3 producer may emit legacy `SUCCESS`, `FAILED`, or an unpaired arbitrary string. Same-token replay preserves the complete first ACK; new-token dedupe preserves the domain pair but sets its declared replay `duplicate` value and uses only the fresh token. For each producer/branch, the table declares its effect class, exact pair, bounded `detail`/`reason`, duplicate rule, nullable applied version, protected ledger provenance, and token source. Execute the real canonicalizer and v3 server controller chain. Every valid first application returns `accepted:true`; the first three are terminal, non-exhausted retryable is accepted/nonterminal, and exhausted retryable is accepted/terminal. `accepted:false`, unknown result, or token loss is a v3 contract failure. Reconciliation-specific/device/raw fields never enlarge the nine-field request.

```js
msg._commandAckEntries = [...groups.values()].map((group) => ({
  outboxIds: group.rows.map((row) => Number(row.id)),
  commandId: group.commandId,
  protocol: group.protocol,
  leaseToken: group.leaseToken,
  canonicalAck: group.canonicalAck,
}));
```

If every row in a protocol/command/token group has the same canonical ACK, send it once and retain all `outboxIds`. More than one live token group for the same command outside the atomic new-lease supersession transaction sends none, increments bounded durable retry metadata, and warns with only command ID/row count. Exclude malformed rows similarly without payload bytes. Add full nine-field, absent-nullable-key, alias, invalid-token, conflicting-token, wrong-type, unknown-field, malformed-position, v2/v3 separation, and real-v3-POST-body cases. The latter must pass OSI Server's scoped strict v3 body parser. Do not correlate by array position or silently select a local duplicate.

- [ ] **Step 2: Classify each server result**

On v3 non-2xx, wrong/missing protocol header, redirect, or malformed response, increment retry metadata for every sent v3 entry and keep the capability pin. On a valid v3 response, index `payload.results` by normalized `commandId`. A v3 ACK outbox row is delivered only when exactly one result has `accepted === true`, regardless of its lifecycle `terminal` value. Missing/duplicate results, non-Boolean fields, or `accepted !== true` remain pending. `terminal` is retained only for command/linked-auth lifecycle evidence and must never decide ACK transport completion. The isolated v2 batch follows its existing compatibility classifier and can never satisfy a v3 row or v3 acceptance test.

```js
const acceptedOutboxIds = [];
const retryOutboxIds = [];
for (const entry of msg._commandAckEntries) {
  const matches = resultsByCommandId.get(entry.commandId) || [];
  if (matches.length === 1 && matches[0].accepted === true) {
    acceptedOutboxIds.push(...entry.outboxIds);
  } else {
    retryOutboxIds.push(...entry.outboxIds);
  }
}
```

The v3 server owns lifecycle terminality and transport acceptance. Do not duplicate its response-status list on the edge. Assert accepted/retry ID sets are disjoint and exhaustive. Add non-2xx → same-token byte-identical retry and lost-response replay for terminal and retryable ACKs. A terminal token-free ledger outcome binds a fresh server token and replays without another effect. `INTENT_PERSISTED` is not terminal: after an accepted/nonterminal retryable ACK and fresh lease token, an idempotent external producer rereads/reconciles/resumes the same intent, then completes once; an ambiguous at-most-once effect stays reconciliation-required. Also cover first request dropped until lease expiry, new-token supersession, and delayed old request/response. An old token with an existing receipt returns its persisted accepted result without touching the current lease; an unreceipted superseded token is unaccepted but its edge row has already been atomically retired by the fresh envelope. Unknown/mismatched tokens remain unaccepted.

- [ ] **Step 3: Update verifier expectations and run tests**

Forbid the old `_commandAckIds` full-batch update. Require `_commandAckEntries`, `result.accepted === true`, and separate accepted/retry SQL updates; a mutation that substitutes `terminal` must fail.

```bash
node scripts/test-sync-delivery-fail-closed.js --section ack
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state/index.test.js
node --test scripts/audit-command-ack-state.test.js
node --test scripts/audit-farming-database-state.test.js scripts/seal-database-restore-baseline.test.js scripts/database-integrity-recovery.test.js
node --test scripts/reconcile-command-ack-state.test.js
node scripts/verify-command-activity-witness.js
node --test scripts/sync-protocol-capability-cli.test.js
node --test scripts/factory-database-seed-cli.test.js
node --test scripts/deployment-state-cli.test.js
node scripts/test-flows-wiring.js
node scripts/verify-sync-flow.js
```

- [ ] **Step 4: Mirror and checkpoint the green ACK subset**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
node scripts/test-sync-delivery-fail-closed.js --section delivery
node scripts/test-sync-delivery-fail-closed.js --section ack
node scripts/verify-profile-parity.js
```

Do not commit yet; the command section remains red until Task 4.

### Task 4: Put every pending command behind dedupe and durable rejection

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/verify-sync-contract.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Test: `scripts/test-sync-delivery-fail-closed.js`

**Interfaces:**

- Produces: registry entry `WORK_REQUEST_STATUS: { dispatch:'work_request_status', actuator:false, requires_duration:false }`.
- Produces: `pending-command-family-router`, with normal command output 1 and work-request-status output 2.
- Produces: terminal validation ledger/outbox state through the shared SQLite transaction API, followed only by the wake-only `command-ack-queue-rest` node.

- [ ] **Step 1: Write the red wiring pins**

Require this exact order:

```text
sync-pending-split
  -> command-dedupe-dispatch
  -> reject-indefinite-open
  -> pending-command-family-router
     output 1 -> journal-command-apply-fn
     output 2 -> work-request-status-apply
```

`command-dedupe-dispatch` output 2 means its transaction has already validated/created the exact replay outbox row and carries only a wake. `reject-indefinite-open` must complete rejection plus ledger/outbox in its own shared transaction before output 2 reaches the wake-only `command-ack-queue-rest`. Forbid a raw ACK payload on either edge, a second queue insert in the wake node, or any direct `sync-pending-split -> work-request-status-apply` edge.

- [ ] **Step 2: Register the status command and move recognition into dedupe**

Add `WORK_REQUEST_STATUS` to `cmd-type-registry` and its local fallback. In `command-dedupe-dispatch`, derive `runtime.command_type_recognized` from the registry and the trusted envelope type before calling `deduplicatePendingCommand`:

```js
const commandTypes = flow.get('command_types') || {};
runtime.command_type_recognized = Object.prototype.hasOwnProperty.call(commandTypes, commandType);
```

Do not trust a payload-side `_commandTypeRecognized` flag.

- [ ] **Step 3: Fail closed on pending-command transport status**

At the head of `sync-pending-split`, use the same literal integer 2xx predicate as the outbox/bootstrap consumers:

```js
function isHttpSuccess(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;
}
```

Return without constructing `_pendingCommandEnvelope` or emitting any output for status zero, missing, non-numeric, or non-2xx. Preserve a bounded poll error and do not set `lastPendingCommandPollSuccessAt` or clear prior error state. The executable tests use a syntactically valid command body in every negative case so body validation cannot accidentally make the test pass. Add structural pins for the predicate and forbidden truthy-status form.

- [ ] **Step 4: Rewire dedupe before validation and mutation**

Change `sync-pending-split` to one output containing every protected envelope. It still validates the HTTP response and constructs `_pendingCommandEnvelope`; it no longer separates status commands. Route unhandled dedupe output to `reject-indefinite-open`, then use the new two-output family router after validation. Give the new router a fresh 16-character lowercase hexadecimal Node-RED ID, exactly two outputs, and no direct path around `command-dedupe-dispatch`.

Delete `SEPARATELY_ROUTED_COMMANDS`, `SEPARATE_ROUTE_SPECS`, and `extractSeparatelyRoutedCommandTypes` from `scripts/verify-sync-contract.js`. `WORK_REQUEST_STATUS` now belongs to the normal Command Type Registry, so the schema enum is exactly registry plus staged commands. Add a verifier assertion that the registry contains it and that `sync-pending-split` does not wire directly to `work-request-status-apply`. Do not preserve the old exception under a new name.

- [ ] **Step 5: Emit durable terminal validation ACKs**

Make `reject-indefinite-open` an async two-output function. Output 1 carries accepted commands. A rejection awaits the shared SQLite completion API using the protected ledger context; that single transaction writes the token-free terminal result and exact token-bound outbox row. Only after the commit may output 2 carry the data-free wake:

```js
async function reject(reason) {
  await commandLedger.completeRejectedValidation(db, msg._commandLedgerContext, {
    result: 'REJECTED_PERMANENT',
    reason,
  });
  return [null, { _commandAckWake: true }];
}
```

Use stable reasons `indefinite_open_not_allowed`, `unknown_command_type`, and `missing_or_invalid_duration`. The helper constructs the v3 nine-field request from the protected pending envelope and frozen ledger context. The validation node cannot return or forward an ACK, token, command ID, outbox ID, or `_commandLedgerContext`; the wake node rejects any such key and never opens a database. A missing/non-v3 context or any transport attempt to supply device EUI, command type, effect key, payload hash, or capability identity fails before commit. The isolated v2 branch keeps its existing shape and never enters this v3 canonicalizer. Do not add direct SQL to the validation node.

- [ ] **Step 6: Run replay, safety, and wiring tests**

```bash
node scripts/test-sync-delivery-fail-closed.js
node scripts/test-flows-wiring.js
node scripts/verify-command-safety.js
node scripts/verify-sync-contract.js
node scripts/verify-sync-flow.js
node scripts/verify-helper-registration.js
node --test scripts/verify-helper-registration.test.js
node --test scripts/audit-command-ack-state.test.js
node --test scripts/audit-farming-database-state.test.js scripts/seal-database-restore-baseline.test.js scripts/database-integrity-recovery.test.js
node --test scripts/reconcile-command-ack-state.test.js
node scripts/verify-command-activity-witness.js
node --test scripts/sync-protocol-capability-cli.test.js
node --test scripts/factory-database-seed-cli.test.js
node --test scripts/deployment-state-cli.test.js
node scripts/generate-factory-image-provenance.js --refresh-bound-hashes --preserve-image-build-id --check
node --test scripts/generate-factory-image-provenance.test.js
node scripts/verify-factory-image-provenance.js
node --test scripts/verify-factory-image-provenance.test.js
node --test scripts/verify-built-factory-image-provenance.test.js
node --test scripts/verify-profile-parity.test.js
sh scripts/pi/backup-pre-deploy.test.sh
sh scripts/pi/restore-pre-deploy.test.sh
node scripts/verify-command-ledger-consumers.js
node --test scripts/verify-command-ledger-consumers.test.js
node scripts/test-journal-command-path.js
node scripts/test-journal-lifecycle.js
node scripts/test-journal-api.js
/bin/sh scripts/test-deploy-sh.sh --mode train-a-compat
busybox ash scripts/test-deploy-sh.sh --mode train-a-compat
node --test scripts/test-deploy-atomic-payload-wiring.js
sh scripts/test-gateway-identity-helper.sh
sh scripts/test-osi-identityd.sh
sh scripts/test-identityd-service-lifecycle.sh
node scripts/verify-live-gateway-identity.js
node --test scripts/test-deploy-migration-wiring.js
node scripts/test-journal-bootstrap.js
sh scripts/test-image-guard-bootstrap.sh
```

Expected: altered same-ID work-request replay performs one local update; all three invalid commands produce durable terminal ACKs; no invalid command reaches a downlink or mutation node; and every injected crash either resumes an idempotent effect, completes a single SQLite transaction, or stops at reconciliation-required without a second actuation.

- [ ] **Step 7: Wire the now-green full suite into CI**

Add immediately after `verify-sync-flow.js`:

```yaml
- name: Verify sync delivery fails closed
  run: node scripts/test-sync-delivery-fail-closed.js
- name: Verify command ledger replay
  run: |
    node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
    node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js
- name: Verify durable sync protocol capability state
  run: |
    node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
    node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state/index.test.js
    node --test scripts/sync-protocol-capability-cli.test.js
    node --test scripts/factory-database-seed-cli.test.js
    node --test scripts/deployment-state-cli.test.js
- name: Verify factory trust bundle after protocol changes
  run: |
    node scripts/generate-factory-image-provenance.js --refresh-bound-hashes --preserve-image-build-id --check
    node --test scripts/generate-factory-image-provenance.test.js
    node scripts/verify-factory-image-provenance.js
    node --test scripts/verify-factory-image-provenance.test.js
    node --test scripts/verify-built-factory-image-provenance.test.js
    node --test scripts/verify-profile-parity.test.js
    sh scripts/test-image-guard-bootstrap.sh
- name: Verify historical ACK state audit
  run: node --test scripts/audit-command-ack-state.test.js
- name: Verify whole farming database audit
  run: node --test scripts/audit-farming-database-state.test.js scripts/seal-database-restore-baseline.test.js scripts/database-integrity-recovery.test.js
- name: Verify historical ACK state reconciliation
  run: node --test scripts/reconcile-command-ack-state.test.js
- name: Verify command activity witness coverage
  run: node scripts/verify-command-activity-witness.js
- name: Verify sync helper shipping surfaces
  run: |
    node scripts/verify-helper-registration.js
    node --test scripts/verify-helper-registration.test.js
- name: Verify all command ledger consumers
  run: |
    node scripts/verify-command-ledger-consumers.js
    node --test scripts/verify-command-ledger-consumers.test.js
    node scripts/test-journal-command-path.js
    node scripts/test-journal-lifecycle.js
    node scripts/test-journal-api.js
- name: Provision BusyBox for the deploy boundary
  run: |
    sudo apt-get update
    sudo apt-get install -y busybox-static
    busybox --help 2>&1 | head -n 1
    busybox ash -c 'printf "%s\n" BUSYBOX_ASH_READY'
- name: Verify stop-loss deployment ownership
  run: |
    sh scripts/pi/backup-pre-deploy.test.sh
    sh scripts/pi/restore-pre-deploy.test.sh
    /bin/sh scripts/test-deploy-sh.sh --mode train-a-compat
    busybox ash scripts/test-deploy-sh.sh --mode train-a-compat
    node --test scripts/test-deploy-atomic-payload-wiring.js
- name: Preserve merged gateway identity lifecycle
  run: |
    sh scripts/test-gateway-identity-helper.sh
    sh scripts/test-osi-identityd.sh
    sh scripts/test-identityd-service-lifecycle.sh
    node scripts/verify-live-gateway-identity.js
    node --test scripts/test-deploy-migration-wiring.js
    node scripts/test-journal-bootstrap.js
    sh scripts/test-image-guard-bootstrap.sh
    node scripts/verify-profile-parity.js
- name: Verify measured flow-size ownership
  run: node scripts/verify-flows-size-ratchet.js
```

Extend `scripts/test-ci-guard-wiring.js` with the complete direct command union above and remove-one negatives for audit/reconciliation/capability/deployment-state/backup/restore/factory-bootstrap/trust-bundle tests and both real deploy modes. It requires the non-writing bound-hash refresh check before semantic/profile/built-rootfs/image-guard verification, and removes the refresh command, each of four anchor inputs, each source↔resident comparison, each verifier, or their ordering independently. It also removes the `busybox-static` install, the help/version proof, the `ash` readiness probe, and their ordering before every BusyBox-owned command. The workflow may not depend on stale committed anchors, the runner image, or the aggregate flow test to cover delivery classification, ledger/token replay, helper registration, durable external-intent transactions, capability factory initialization/pin/reset/disposition/restore-preparation/invalidation, live-history audit, or stopped-writer reconciliation. Extend A0 artifact/deploy tests with missing audit/reconcile/capability executable, resident ROM copy, trust anchor, or dependency; changed spawned argv; pre-arm initialize/disposition; factory-zero, zero/rebind/quarantine/preparation/invalidation receipt paths; every `protocol-*` crash; all four immutable restore-preparation results and wrong-general-backup; existing-chain overwrite/rollback; factory/ordinary CLEAR verification; quarantine hard block; start from UNASSESSED/RECONCILIATION_REQUIRED; negotiation-only start from CLEAR+UNNEGOTIATED; and dispatch attempts before NEGOTIATED. They execute real `deploy.sh` and spawned CLIs rather than matching source text.

Before this commit, run `scripts/flows-size-scan.js` against the fixed integrated pre-Task-3 flow and final canonical flow. Replace only each changed node's absolute `max_chars` and the absolute `max_total` with the exact measured final values, retaining bounded sync-delivery ownership reasons. Extend the executable verifier with an extra-character mutation that fails without another explicit ceiling edit. Run `node scripts/verify-flows-size-ratchet.js`; stale delta fields, rounding, wildcards, unused or unowned ceilings fail.

- [ ] **Step 8: Mirror and commit the deployable activation slice**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/commands.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/commands.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/lifecycle.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-sync-protocol-state \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package-lock.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/98_osi_node_red_seed \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib/index.test.js \
  scripts/audit-command-ack-state.js scripts/audit-command-ack-state.test.js \
  scripts/audit-farming-database-state.js scripts/audit-farming-database-state.test.js \
  scripts/seal-database-restore-baseline.js scripts/seal-database-restore-baseline.test.js \
  scripts/database-integrity-recovery.js scripts/database-integrity-recovery.test.js \
  scripts/manifests/database-restore-reverse-adapters.json \
  scripts/manifests/database-recovery-implementations.json \
  scripts/manifests/database-integrity-source-trust-roots.json \
  scripts/trust/database-integrity/ \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-audit-command-ack-state.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-audit-command-ack-state.js \
  scripts/verify-command-ledger-consumers.js scripts/verify-command-ledger-consumers.test.js \
  scripts/test-journal-command-path.js scripts/test-journal-lifecycle.js scripts/test-journal-api.js \
  scripts/reconcile-command-ack-state.js scripts/reconcile-command-ack-state.test.js \
  scripts/verify-command-activity-witness.js \
  scripts/sync-protocol-capability-cli.js scripts/sync-protocol-capability-cli.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-sync-protocol-capability-cli.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-sync-protocol-capability-cli.js \
  scripts/lib/factory-image-provenance.js \
  scripts/factory-image-provenance-cli.js scripts/factory-image-provenance-cli.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-factory-image-provenance.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-factory-image-provenance.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-factory-image-provenance-cli.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-factory-image-provenance-cli.js \
  scripts/generate-factory-image-provenance.js scripts/generate-factory-image-provenance.test.js \
  scripts/verify-factory-image-provenance.js scripts/verify-factory-image-provenance.test.js \
  scripts/verify-built-factory-image-provenance.js scripts/verify-built-factory-image-provenance.test.js \
  scripts/verify-profile-parity.js scripts/verify-profile-parity.test.js \
  scripts/test-image-guard-bootstrap.sh \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/osi-deploy/image-guard-manifest.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/osi-deploy/image-guard-manifest.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/osi-deploy/factory-image-provenance.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/osi-deploy/factory-image-provenance.json \
  scripts/lib/deployment-state.js scripts/deployment-state-cli.js scripts/deployment-state-cli.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-deployment-state.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-deployment-state-cli.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-deployment-state.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-deployment-state-cli.js \
  scripts/build-train-a-deployment-artifact.js scripts/build-train-a-deployment-artifact.test.js \
  scripts/verify-train-a-deployment-artifact.js scripts/verify-train-a-deployment-artifact.test.js \
  scripts/pi/backup-pre-deploy.sh scripts/pi/backup-pre-deploy.test.sh \
  scripts/pi/restore-pre-deploy.sh scripts/pi/restore-pre-deploy.test.sh deploy.sh \
  scripts/test-deploy-sh.sh scripts/test-deploy-atomic-payload-wiring.js \
  scripts/test-flows-wiring.js scripts/verify-sync-contract.js scripts/verify-sync-flow.js \
  scripts/verify-live-gateway-identity.js scripts/test-deploy-migration-wiring.js \
  scripts/test-journal-bootstrap.js \
  scripts/test-sync-delivery-fail-closed.js scripts/test-ci-guard-wiring.js \
  scripts/verify-helper-registration.js scripts/verify-helper-registration.test.js \
  scripts/verify-flows-size-ratchet-allowances.json \
  .github/workflows/verify-sync-flow.yml
git commit -m "fix: activate fail-closed sync delivery"
```

Before this commit, verify the three exact green checkpoint commits above are ancestors in order, their trees contain no flow/deploy caller of dormant restore/activity APIs, and the activation diff supplies every caller plus the full workflow union. A squashed single Task 3/4 commit or a deployable intermediate SHA fails review.

Immediately verify `git status --short`, the ordered four-commit log, `git diff --name-status <pre-slice-base>...HEAD`, and `git show --name-status --stat HEAD`. Across the exact four-commit range, both profile ledger/DB/protocol-state implementations and tests, `osi-lib` registration, source plus ROM audit/protocol CLIs, all four regenerated factory trust anchors, generator/verifier changes, artifact/backup/deploy extensions, and audit/reconciliation scripts must be committed. The activation `git show HEAD` must contain only its assigned caller/deploy/workflow activation delta and must be the first deployable commit. None may remain as dirty-tree input that makes factory boot or Task 5 pass accidentally. Task 5 then stages only its trigger-readiness delta because those owners are already committed.

### Task 5: Refuse sync readiness when a required trigger is missing

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-runtime-schema-parity.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify/Extend: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js`
- Modify/Extend: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js` (created in Task 3)
- Modify/Extend: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.js`
- Modify/Extend: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.test.js` (created in Task 3)
- Modify: `docs/adr/2026-06-30-schema-and-contract-ownership.md`
- Modify: `AGENTS.md`
- Test: `scripts/test-sync-delivery-fail-closed.js`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify/Extend: `scripts/test-ci-guard-wiring.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces:**

- Produces: `requiredTriggerDefinitions`, derived from the existing `triggers` array at runtime as normalized name/body pairs.
- Produces: readiness only after the complete trigger set commits atomically and every expected trigger body matches `sqlite_master.sql`.
- Produces: `osiDb.createDedicatedDatabase(path)`, whose queue/handle is not the module-global shared connection.
- Produces: `osiDb.enterFailStop(name, dedicatedDb, reason) -> Promise<never>`, which atomically poisons every new shared-facade operation and facade construction, retains the dedicated connection in a module-level strong-reference map, and never settles or closes it before process exit.
- Produces: a fail-stop path that retains the dedicated connection's uncommitted exclusive transaction, schedules `/etc/init.d/node-red stop`, and never returns the gateway to writable service when trigger readiness fails.

- [ ] **Step 1: Add a failing trigger-readiness rehearsal**

Extend the executable suite with a fake database that reports one expected trigger missing after the DDL loop. Add a same-name/stale-body case, a swallowed `DROP TRIGGER` error, and a swallowed `CREATE TRIGGER` error. Require `node.error` to receive bounded trigger-readiness failure, forbid green `sync ready` status, and require the fail-stop collaborator exactly once. On the failure path, forbid `COMMIT`, `ROLLBACK`, database close, downstream output, and any later domain mutation. A second real SQLite connection must receive `SQLITE_BUSY`, while existing and newly constructed ordinary `osi-db-helper` facades must reject `run`, `exec`, `all`, `get`, `transaction`, `readSnapshot`, and any other operation before enqueue and emit no success side effect. Include DML passed through `all` and `exec` negatives; method names are not a safe read/write classifier. Run the fail-stop child with `node --expose-gc` and assert `typeof global.gc === 'function'` before forcing collection; absence is failure, never a skip. Delay or fail stop scheduling; all paths remain blocked until the child test process is terminated, at which point the uncommitted trigger changes roll back. Only the complete matching inventory with zero trigger-DDL errors commits, closes, and retains green readiness.

- [ ] **Step 2: Replace per-statement best effort with one atomic trigger gate**

Preserve trigger-pair order, but run the complete DROP/CREATE set plus the postcondition through `createDedicatedDatabase` inside one manually controlled `BEGIN EXCLUSIVE` transaction. Do not use the shared facade or a helper that auto-rolls back on rejection. A failed replacement therefore cannot commit a half-new trigger set, the dedicated open transaction blocks other SQLite connections, and `enterFailStop` blocks same-process shared-facade writes while the fail-stop path shuts Node-RED down. Derive name/body pairs only from the `CREATE TRIGGER` statements and query the live inventory before `COMMIT`:

```js
const requiredTriggerDefinitions = deriveTriggerDefinitions(triggers);
const triggerRows = await _db.all(
  "SELECT name, sql FROM sqlite_master WHERE type='trigger'"
);
const live = new Map((triggerRows || []).map((row) => [
  String(row.name || ''), normalizeTriggerSql(row.sql)
]));
const mismatches = requiredTriggerDefinitions.filter((trigger) =>
  live.get(trigger.name) !== trigger.normalizedSql
);
if (triggerDdlErrors.length || mismatches.length) {
  throw new Error('sync trigger readiness failed: ddl_errors=' +
    triggerDdlErrors.length + ',mismatches=' +
    mismatches.map((item) => item.name).join(','));
}
```

`normalizeTriggerSql` must be a token-aware scanner, not regex replacement or global lowercase. It may remove SQLite's non-semantic `IF NOT EXISTS`, one trailing semicolon, unquoted keyword/identifier case, and token-separating whitespace only while outside quoted tokens. Preserve every single-quoted, double-quoted, backtick-quoted, bracket-quoted, and blob token byte-for-byte, including case, spaces, escaped quotes, and quote count; SQLite DQS compatibility means the verifier must not guess whether a double-quoted token is an identifier or string. Reject unterminated/unknown lexical forms. Add negatives that change only single- or double-quoted token case/spacing, doubled quotes, blob bytes, `WHEN`, and INSERT payload; every one remains a mismatch.

On success, `COMMIT`, set the ready status, and close. On any DDL, parse, inventory, or comparison failure after `BEGIN EXCLUSIVE`, set red status, call `node.error`, use the already configured `global.get('cp')` to spawn a detached, bounded `/etc/init.d/node-red stop`, and then `return await osiDb.enterFailStop('sync-trigger-readiness', _db, boundedReason)`. The helper stores `_db` in a process-lifetime strong map, poisons all shared writes, and returns one never-settling promise; no catch/finally may close or roll back it. If stop scheduling fails, enter the same gate and surface the secondary bounded error. Add a source guard that pins `cp: require('child_process')` in shipped settings and the exact fail-stop command. This is the actual write gate: status color alone is not readiness.

- [ ] **Step 3: Extend schema parity verification**

Before changing the boot function, capture the exact Task 4 flow-size baseline. After implementation, run `scripts/flows-size-scan.js` and replace only the boot node's absolute `max_chars` plus absolute `max_total` with the exact final values. Preserve every Task 3 owned ceiling/reason. The verifier appends one character and proves it fails until the exact ceiling is updated; stale delta fields, missing, rounded, wildcard, or unused ceilings fail.

Require every unique runtime-derived definition to have a same-name, normalized same-body trigger in `database/seed-blank.sql`; allow the seed's additional `trg_improvement_requests_outbox_ai` and `sync_dendro_to_readings` definitions outside this frozen boot array. Separately require the live postcondition to match every runtime-derived body. Add negative self-tests that introduce one runtime-only name, remove one live runtime trigger, retain a stale same-name body, change only string/blob literal bytes, and inject a trigger-DDL execution error; all must fail without committing DDL or permitting a canonical write.

- [ ] **Step 4: Run the boot-node merge gate**

Add both direct boot-DDL verifiers and the GC-capable child invocation to the required workflow. Extend `scripts/test-ci-guard-wiring.js` with remove-one and `--expose-gc`-removal negatives; the aggregate verifier or a plain `node` invocation cannot substitute for these commands.

```bash
node --expose-gc scripts/test-sync-delivery-fail-closed.js --section trigger-readiness
node scripts/test-sync-delivery-fail-closed.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-profile-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-flows-size-ratchet.js
node .claude/skills/anti-slop-writing/slop-check.js \
  docs/adr/2026-06-30-schema-and-contract-ownership.md AGENTS.md
```

- [ ] **Step 5: Mirror and commit**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper/index.test.js \
  scripts/verify-runtime-schema-parity.js scripts/verify-sync-flow.js \
  scripts/test-sync-delivery-fail-closed.js scripts/test-ci-guard-wiring.js \
  scripts/verify-flows-size-ratchet-allowances.json \
  .github/workflows/verify-sync-flow.yml \
  docs/adr/2026-06-30-schema-and-contract-ownership.md
if [ "${OSI_REPAIR_PROGRAM_MODE:-0}" != "1" ]; then
  git add AGENTS.md
fi
git commit -m "fix: fail sync readiness on missing triggers"
```

### Task 6: Run local gates and Kaba100 stop-loss verification

**Files:**

- Modify: `docs/contracts/sync-schema/README.md`
- Modify: `AGENTS.md`
- Runtime evidence through the existing pipeline collector.

**Interfaces:**

- Consumes: Tasks 1 through 5.
- Produces: local proof plus a live retry/identity rehearsal without production-cloud access.

When this source plan runs through `2026-07-15-refactor-repair-program.md`, Tasks 6 Steps 4–6 are verification legs of the single Train A Task A4 deployment. Consume A4's exact deployment ID, backup manifest, compatibility/runtime manifests, deployment receipt, and verification boundary; do not take a second backup, invoke a second deploy, restart a role outside the guarded controller, or infer a sealed-release symlink that Train A compatibility mode does not create. The standalone backup/deploy wording below applies only if this plan is explicitly authorized and executed outside the repair program.

- [ ] **Step 1: Record the durable contract**

Document these rules:

```text
HTTP 2xx is only a transport result. Event delivery advances for its unique
terminal event status. V3 command-ACK transport delivery advances for its unique
accepted:true result; lifecycle terminality is independent.

Every pending command is deduplicated before validation or mutation. Permanent
validation failures are terminal ACKs, not dropped messages.

The first valid protocol-3 response pins that exact linked-server identity in
fsynced /data state. Reboot, restart, timeout, malformed response, or relink
polling cannot downgrade it. Only the stopped-writer, backup-bound reset CLI
can authorize a new negotiation epoch.

These stop-loss guarantees cover the additive v3 command path. Legacy v2 stays
byte-compatible and isolated for old fleet members; it is not evidence of the
v3 guarantees. Full-fleet completion requires a separate release gate that
inventories every linked gateway as v3-pinned, upgrades or quarantines the
remainder, and separately approves v2 endpoint retirement.
```

In `AGENTS.md`, add the same rules in compact form and state that trigger readiness requires the post-DDL inventory.

- [ ] **Step 2: Run the complete local gate set**

```bash
node scripts/test-sync-delivery-fail-closed.js
node --expose-gc scripts/test-sync-delivery-fail-closed.js --section trigger-readiness
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state/index.test.js
node --test scripts/audit-command-ack-state.test.js
node --test scripts/audit-farming-database-state.test.js scripts/seal-database-restore-baseline.test.js scripts/database-integrity-recovery.test.js
node --test scripts/reconcile-command-ack-state.test.js
node scripts/verify-command-activity-witness.js
node --test scripts/sync-protocol-capability-cli.test.js
node --test scripts/deployment-state-cli.test.js
sh scripts/pi/backup-pre-deploy.test.sh
sh scripts/pi/restore-pre-deploy.test.sh
node scripts/verify-helper-registration.js
node --test scripts/verify-helper-registration.test.js
node scripts/verify-command-ledger-consumers.js
node --test scripts/verify-command-ledger-consumers.test.js
node scripts/test-journal-command-path.js
node scripts/test-journal-lifecycle.js
node scripts/test-journal-api.js
/bin/sh scripts/test-deploy-sh.sh --mode train-a-compat
busybox ash scripts/test-deploy-sh.sh --mode train-a-compat
node --test scripts/test-deploy-atomic-payload-wiring.js
sh scripts/test-gateway-identity-helper.sh
sh scripts/test-osi-identityd.sh
sh scripts/test-identityd-service-lifecycle.sh
node scripts/verify-live-gateway-identity.js
node --test scripts/test-deploy-migration-wiring.js
node scripts/test-journal-bootstrap.js
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-op-parity.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-command-safety.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-profile-parity.js
node .claude/skills/anti-slop-writing/slop-check.js \
  docs/contracts/sync-schema/README.md AGENTS.md
git diff --check
```

- [ ] **Step 3: Commit the reviewed contract documentation**

```bash
git add docs/contracts/sync-schema/README.md
if [ "${OSI_REPAIR_PROGRAM_MODE:-0}" != "1" ]; then
  git add AGENTS.md
fi
git commit -m "docs: record fail-closed sync delivery invariants"
```

Do not put live evidence claims in this pre-deploy documentation commit. Evidence is recorded separately after the rehearsal.

- [ ] **Step 4: Take the Kaba100 backup and deploy the exact commit**

At execution time, load `osi-live-ops-runbook`. In standalone mode, use the guarded stopped-writer path to capture application/ChirpStack state plus general and purpose-specific command-ledger images, bind the decisive database/activity audit, and `arm`. If all three existing chains prove receipt-bound historical CLEAR, `databaseRestore.status:'CLEAR'`, valid activity head, plus current-identity NEGOTIATED, CAS directly to `protocol-ready` retaining those hashes. Otherwise CAS `protocol-initializing`, run/revalidate capability/activity initialization, CAS `protocol-dispositioning`, and spawn the reviewed `record-zero|rebind-historical-v2|quarantine-historical-v2` CLI. Verify its receipt, invoke `record-v2-disposition`, and reverify capability, witness, and activity heads. Deploy/start once only from `protocol-ready` with both CLEAR states and valid activity ledger; quarantine or database-restore blocking remains stopped. Under the repair program, verify/reuse A4's same audit/backup/disposition/deployment receipts. Record `PRAGMA quick_check`, scoped/unscoped/outbox/ACK counts, disposition/capability/activity generations, restore epoch/state, sync cursor, gateway-migration flags, and trigger count at shared boundaries.

- [ ] **Step 5: Rehearse transport failure without corrupting durable state**

Against the approved test-server v3 path only, first require the exact protocol-3 capability header and pin. Then use a controlled unreachable REST target or test double. Observe at least one scheduled delivery attempt. Require pending outbox/ACK rows to remain pending, retry metadata to increase, the v3 pin to forbid fallback, `last_full_backfill_at` to remain unchanged, and gateway-migration pause flags to remain set during the failed bootstrap.

Restore the normal test-server target and require the next successful response to drain only entries with one unique `accepted:true` result. Include an accepted/nonterminal retryable ACK so the live proof distinguishes transport completion from command lifecycle terminality. Reverify the capability and independent witness chains' active identity, highest generation, heads, and full-chain hashes. Request one controlled restart through merged identityd restart coordination, make the v3 endpoint return a controlled failure, and prove the persisted pin blocks v2 fallback after restart. Restore v3 and reverify the same identity; do not exercise the downgrade-reset CLI on the live gateway. Do not point the gateway at `osicloud.ch`.

- [ ] **Step 6: Prove command replay and trigger readiness live**

Submit one harmless `WORK_REQUEST_STATUS` command to the test path, replay the same command ID, and require one local mutation plus an exact replay ACK. Restart Node-RED and require the trigger inventory count to match the canonical list before the sync-ready status appears.

## Exit criteria

This plan is complete only when:

- status zero, missing status, non-2xx, and malformed result bodies leave durable delivery pending;
- bootstrap state advances only for HTTP 2xx with `success:true`;
- v3 command ACK delivery follows each server result's unique Boolean `accepted` field and never uses lifecycle `terminal` as transport evidence, while v2 remains an isolated compatibility path;
- a valid v3 response durably pins the exact linked-server identity across reboot/restart, and only the stopped-writer backup-bound reset CLI can open a new negotiation epoch;
- every v3 producer branch canonicalizes to exactly nine fields; a same-token replay is byte-identical, and a new-token ledger replay binds the fresh protected token to a token-free stored outcome;
- the stopped-writer live ACK preflight finds no unknown active transport shape, and any origin-bound legacy quarantine is backup-bound, immutable, and audited;
- `WORK_REQUEST_STATUS` and every other command family pass through durable intent before mutation; SQLite effects commit with ledger/outbox atomically, while ambiguous external effects never auto-repeat;
- invalid permanent commands create durable terminal ACKs and replay without side effects;
- the boot flow refuses green sync readiness when a canonical trigger is absent;
- all changes are mirrored and CI runs the executable fail-closed suite; and
- the Kaba100 rehearsal proves failure retention followed by successful retry against the test path.

Completion of this plan means the Kaba100/test-server v3 path and merge-compatible v2 isolation are green. It does not claim full-fleet stop-loss: that requires a separately approved release gate with a current fleet capability inventory, upgrade/quarantine disposition for every non-v3 gateway, and explicit v2 retirement criteria.
