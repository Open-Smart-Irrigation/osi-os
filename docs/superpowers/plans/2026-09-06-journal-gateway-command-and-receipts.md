# Journal Gateway Command and Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a capability-gated, atomic, idempotent gateway-backed journal batch command and truthful cloud receipt convergence.

**Architecture:** Cloud first accepts and durably tracks a versioned batch intent without claiming a journal save. Edge then advertises the capability, validates every member, applies the batch and ACK in one SQLite transaction, and replays the stored receipt exactly. Cloud promotes each member only after mirror UUID/version/applied-hash convergence.

**Tech Stack:** JSON Schema, Node-RED/Node.js, SQLite transactions, Spring Boot/JPA, Flyway, React/TypeScript, JUnit 5, Vitest.

**Spec:** [Journal Edge/Cloud Parity and Fast Capture](../specs/2026-09-06-journal-edge-cloud-parity-and-fast-capture-design.md), especially §§4.5, 5, 6 and 9.2.

## Global Constraints

- Consumer/storage compatibility lands before any producer enables batching.
- Edge remains canonical for gateway-backed journals. Cloud working copies are never mirrored as canonical entries before matching edge evidence.
- Command limit is 256 KiB, member count 1–100, `contract_version` is 1.
- Effect identity and submitted intent identity are distinct. Same effect key with a different intent is permanently rejected.
- No per-keystroke or draft command is sent to edge.
- Extend edge-owned schemas and golden fixtures, then update cloud vendor copies through the repository verifier workflow.
- Keep both Pi profiles byte-identical and preserve visible error reporting in touched flow function nodes.

---

### Task 1: Specify the batch command in edge-owned contracts

**Files:**
- Modify: `docs/contracts/sync-schema/commands.schema.json`
- Modify: `docs/contracts/sync-schema/effect-keys.md`
- Modify: `docs/contracts/sync-schema/sync-contract-golden.json`
- Modify relevant capability/resource fixtures under `docs/contracts/sync-schema/`.
- Modify: `scripts/test-contract-schemas.js`
- Modify: `scripts/verify-sync-op-parity.js`

- [ ] Add failing schema fixtures for 0, 1, 84, 100, and 101 members; invalid versions; duplicate entry/plot UUID pairs; noncanonical ordering; oversized serialized payload; invalid cycle action; and missing stable UUID/version fields.
- [ ] Define `UPSERT_JOURNAL_ENTRY_BATCH` with the exact shared/member shape from spec §4.5. Keep single-entry string/value bounds.
- [ ] Define effect key `journal_entry_batch:{batch_uuid}:0`, `submitted_intent_hash`, per-member applied receipt, duplicate-candidate result, and capability `journal_entry_batch_v1` in golden metadata.
- [ ] Add golden AgroLink 84-member and maximum 100-member fixtures and assert each serialized command is below 256 KiB.
- [ ] Run `node scripts/verify-sync-contract.js`, `node scripts/test-contract-schemas.js`, and `node scripts/verify-sync-op-parity.js`.
- [ ] Commit as `feat: define journal batch command contract`.

### Task 2: Land cloud consumer storage and receipt state machine first

**Files:**
- Add: `backend/src/main/resources/db/migration/V2026_09_06_001__journal_working_copies_and_batch_receipts.sql` (reconfirm no later migration has landed before execution).
- Modify journal gateway capability/controller/service/entity/repository classes under `backend/src/main/java/org/osi/server/journal/` and `journal/v2/`.
- Add/modify focused tests under `backend/src/test/java/org/osi/server/journal/`.
- Update vendored schemas under `backend/src/test/resources/sync-contract/` using the existing vendor procedure.

**Interfaces:**
- Persist batch UUID, effect key, submitted intent hash, canonical member order, working-copy payload, command/ACK state, per-member edge receipt, and mirror-convergence evidence.
- Public states: draft/working copy, queued/pending, failed retryable, rejected permanent/conflict/expired, unknown after timeout, applied-on-farm-syncing, partial N/total, canonical applied.

- [ ] Add migration/entity tests proving uniqueness for batch UUID/effect key, immutable submitted intent, per-member uniqueness, durable working copies, and rollback-safe constraints.
- [ ] Add service tests for exact replay, same-key/different-intent rejection, timeout receipt lookup before retry, every ACK state, missing/reordered/duplicate ACKs, and partial mirror arrival.
- [ ] Add convergence tests requiring exact member UUID + sync version + edge applied aggregate hash. Assert submitted intent hash alone never promotes a member.
- [ ] Implement the additive migration and storage model. Run the focused Flyway test before service work.
- [ ] Extend cloud command acceptance/serialization while keeping UI production disabled unless observed gateway capability contains `journal_entry_batch_v1`.
- [ ] Implement state transitions and read projections for Drafts / Needs completion and Waiting for farm. Do not place working copies in canonical table/export queries.
- [ ] Vendor and verify edge contracts with `scripts/verify-edge-sync-contract-vendor.sh`.
- [ ] Run targeted JUnit tests and commit as `feat: track gateway journal batch receipts`.

### Task 3: Implement the edge atomic batch applier

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/commands.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js`
- Modify their existing journal package tests and mirror all runtime changes under bcm2709.
- Modify: `scripts/migrate-flows-journal-commands.js`
- Modify/add: `scripts/test-journal-command-path.js` and migration tests.

- [ ] Add failing tests for unsupported capability, canonical 1/84/100-member apply, mixed valid/invalid all-or-none rollback, duplicate candidate receipts, per-member cycles, ambiguous cycles, deactivated plot, changed layout/catalog, authorization loss, and 256 KiB enforcement.
- [ ] Add idempotency tests proving exact replay writes no entries/values/outbox/ACK rows and returns the stored receipt byte-for-byte; changed intent at the same effect key is permanently rejected.
- [ ] Add transaction fault-injection at entry, value, outbox aggregate, ledger terminal result, and ACK outbox stages; assert every fault rolls back the whole batch.
- [ ] Reuse the existing canonical single/batch finalization functions rather than duplicating value/context validation. Derive zone, season, and context separately per member.
- [ ] Canonicalize members by `(plot_uuid, entry_uuid)` before hashing. Persist the separately computed submitted intent hash and per-member aggregate hashes.
- [ ] Register command handling and advertise `journal_entry_batch_v1` only in the same release. Unsupported older edges keep durable permanent rejection behavior.
- [ ] Apply the sanctioned flow migration script to both profiles; do not hand-edit `flows.json`.
- [ ] Run `node scripts/test-journal-command-path.js`, migration tests, `verify-sync-op-parity`, `verify-sync-flow`, `verify-no-new-silent-catch`, and profile parity.
- [ ] Commit as `feat: apply atomic journal batches at edge`.

### Task 4: Expose truthful receipt behavior to the frontend adapter

**Files:**
- Modify cloud journal API service/types.
- Add pure receipt reducer/state-machine module and tests under `frontend/src/journal/`.
- Modify shared capture adapter implementation and tray components in the UI plan.

- [ ] Add reducer tests for queued, leased, failed-retryable, conflict, expired, permanent rejection, timeout unknown, edge-applied-before-mirror, 1-of-N, N-of-N, reordered mirror, wrong version/hash, and late recovery.
- [ ] Implement one normalized receipt projection at the service boundary. Components must not interpret raw backend enum combinations.
- [ ] Show pending commands only in Waiting for farm, including `N of total synced`; allow safe receipt lookup/retry actions according to backend state.
- [ ] Remove a working copy and update recents only at canonical APPLIED. Never synthesize missing canonical entries.
- [ ] Confirm gateway-backed capture hides attachments and cloud-primary behavior is unchanged.
- [ ] Run focused frontend tests and commit as `fix: present journal command convergence honestly`.

### Task 5: Independent contract verification

- [ ] Run every edge contract/command/profile gate in spec §9.3.
- [ ] Run cloud vendoring, migration, command, receipt, and full backend tests.
- [ ] Inspect both 84- and 100-member serialized fixtures and record sizes.
- [ ] Confirm capability absence keeps cloud gateway multi-plot disabled without blocking single-entry capture.
- [ ] Record both repository commit SHAs and clean statuses before UI integration.
