# AgroLink edge/cloud parity autonomous program

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to execute this program one slice at a time.
> Do not dispatch subagents or parallel tasks. Each implementation slice needs
> its own approved design or refreshed implementation plan, test-first
> execution, a separate self-review pass, and current verification evidence.

**Goal:** Bring OSI Server to full parity with portable OSI OS farm workflows,
finish scoped AgroLink account enforcement on both sides, and establish
loss-aware sync and recovery without moving authority away from the edge.

**Architecture:** OSI OS remains canonical. Server-originated edits are durable
pending commands; the cloud may present an optimistic desired-state overlay but
must distinguish pending, applied, conflicted, rejected, and expired changes.
Versioned contracts and capability negotiation allow the two repositories to
roll out independently. Hardware-local operations stay on the edge.

**Tech stack:** Node-RED, SQLite and `lib/osi-migrate` on OSI OS; Spring Boot,
Postgres/Flyway, and React on OSI Server; REST pending commands from cloud to
edge; REST events/bootstrap plus MQTT telemetry from edge to cloud.

**Status:** Ready for autonomous, sequential execution after Task 0 confirms
the launch head. This file does not authorize production access, live
deployment, data deletion, or network-drive implementation.

---

## 1. Program boundary

Full parity means that a portable farm workflow available on OSI OS is also
available through OSI Server with the same domain rules. It does not mean that
the two products expose identical menus.

The following split is binding:

| Surface | Parity rule |
|---|---|
| Zones, schedules, journal, device assignments, device configuration, history, analysis, account scope | Edge and cloud behavior must converge |
| Gateway hardware, ChirpStack bootstrap, local network, fan, filesystem, database download, firmware, network-drive transport | Edge-only unless a remote status view is useful |
| Fleet administration, cloud recovery storage, cross-installation switching, server operations | Cloud-only |
| AgroLink network-drive tables, SMB state, imported external readings | Edge-local by the network-drive design; no sync operations |

The network-drive design v3.1 and Phase 1 plan v2 are reviewed and their
planning work has released the branch. No network-drive implementation commit
exists. This parity program may read those documents for boundary checks but
must not execute the network plan or add drive schema, helpers, flows, or
imports.

The same ownership rule applies to every program sharing
`design-sync/agrolink`, including journal follow-ups and i18n work. Direct
commits are serialized at shared files. A parity worker must obtain a recorded
handoff before editing a file owned by another active program.

## 2. Authority and transport invariants

1. OSI OS writes canonical state to SQLite first and then emits an outbox event.
2. OSI Server mirrors accepted edge state.
3. A cloud edit creates or updates durable desired state and queues a REST
   pending command. It does not rewrite the canonical mirror before edge
   acceptance.
4. Journal edits and zone edits must feel immediate in the cloud. The UI renders
   the desired-state overlay at once and syncs in the background.
5. Commands use version preconditions. A mismatch becomes a recoverable
   conflict with a field-level diff where the resource shape supports one.
6. Continued cloud edits are serialized per resource. Safe config commands may
   be coalesced to the latest desired state; physical commands are never
   coalesced into a different effect.
7. Physical commands are short-lived and expire. Ordinary configuration
   commands remain durable until applied, superseded, rejected, or explicitly
   cancelled.
8. REST is the only cloud-to-edge command path. MQTT remains edge-to-cloud
   telemetry, status, heartbeat, and command ACK.
9. Capability negotiation gates every new event and command type per gateway.
10. Tombstones use `deleted_at`; neither side silently hard-deletes synced state.

## 3. Repository and branch policy

| Repository | Integration branch | Starting rule | Integration rule |
|---|---|---|---|
| `osi-os` | `design-sync/agrolink` | The maintainer first transfers current `main` changes into this branch | Commit and push reviewed slices directly; no PR |
| `osi-server` | `AgroLink` | Create from current `main` after fetching and verifying the base | Commit and push reviewed slices directly; no PR |

Use isolated worktrees for every implementation slice. Never execute a slice in
a dirty checkout. Existing generated GUI assets, office lock files, untracked
plans, and unrelated local edits belong to the maintainer and must not be
staged, deleted, or folded into a parity commit.

Before dispatch, the orchestrator records active program owners and their
hotspots. At minimum, check migration manifests, seed and bundled databases,
both maintained flow profiles, helper registries, locale trees, and generated
GUI assets.

Paired work uses paired commits, not cross-repository commits. Each side's
execution report records the other repository's branch and commit SHA.

## 4. Resolved product decisions

| Topic | Decision |
|---|---|
| Product target | Full parity for portable farm workflows |
| Canonical state | Edge remains authoritative |
| Cloud mutation UX | Optimistic and immediate, backed by durable desired state |
| Conflict policy | Version precondition plus recoverable diff |
| Access administration | Cloud may manage access by pending edge-approved commands |
| Existing account model | Separate accounts remain the default |
| Multiple installations | Exceptional multi-installation users get an installation switcher |
| Authorization scope | Per-gateway membership; never reuse the cloud user's global role |
| Account disabling | Immediate for privilege and physical-effect paths |
| Command lifetime | Short for physical effects, durable for ordinary configuration |
| Pending edits | Serialize per resource and coalesce only safe config state |
| Capability rollout | Per gateway |
| Gateway identity changes | Retain the existing previous-EUI migration path |
| Recovery identity | Add stable `installation_uuid`; keep current sync aggregates keyed by gateway EUI |
| Recovery storage | Hybrid encrypted recovery bundle with server-side envelope encryption |
| Offline verifier | Version 2 binds to installation identity |
| Cloud history retention | Never automatically delete canonical farm history mirrored from the edge |
| Desired state | Durable overlay with explicit pending/applied/conflict/rejected/expired states |
| Device baseline | KIWI, TEKTELIC CLOVER, DRAGINO LSN50, SENSECAP S2120, AQUASCOPE LORAIN, and STREGA |
| UC512 | Retain schema compatibility; hide it from the supported parity catalog |
| Branch delivery | Direct commit and push to `design-sync/agrolink` and `AgroLink`; no PR |

One earlier history question was interrupted: whether the new history-batch
transport may replace the legacy durable path after convergence. The autonomous
default is conservative: implement and prove the durable batch path, but do not
disable or delete the legacy path. That final cutover needs maintainer approval.

The exact server envelope-key provider is also outside autonomous authority if
it introduces a new paid service, cloud account, secret authority, or production
credential. Recovery design and local test implementations may proceed; the
external provider selection must stop for maintainer review.

## 5. Verified starting state

This table records the 2026-07-23 audit. Task 0 must re-verify it at the launch
head.

| Area | Evidence in current code | Program treatment |
|---|---|---|
| Server ingest hardening | Transaction executor, dead letters, retention/admin controls, exception classification, rate/cap coverage | Complete; retain as a gate |
| First server resource applier | `SyncEventApplier` and `GatewayLocationApplier` with tests | Complete pattern; convert other resources when touched |
| Live gateway identity | Identity helper, runtime wiring, verifier on the AgroLink edge branch | Complete; re-run verifier |
| Edge delivery stop-loss | Fail-closed delivery, per-entry result correlation, command reject/dedupe tests | Core complete; do not replay Tasks 1-4 |
| Outbox retention cap | Protected aggregate policy and six passing tests | Complete |
| Device API authentication status | Implemented on the AgroLink edge branch | Complete |
| Device provisioning | Existing bootstrap, registration, claim, assignment, and command paths | Existing capability; parity and authorization work only |
| MQTT credential reconciliation | Implemented on OSI Server | Complete |
| Journal edge | Storage, UI, five event operations, and five pending-command handlers | Edge complete; cloud operations explicitly staged as deferred |
| Journal cloud | No full mirror/API/UI/command issuer | Open |
| Scoped access Phase A | Source head `8921e6d1` includes the accepted `101d1f2f` version fix plus later auth, bootstrap, flag, role, and trigger corrections | Patch source requiring cumulative revalidation; migrations `0022–0023` collide with target migrations through `0032` |
| Scoped access Phases B-D | Detailed edge plans | Reusable after Phase A repair and current-code revalidation |
| Scoped access Phase E | Edge-origin-only cloud design | Rewrite because cloud access administration is now required |
| History remediation | Legacy durable path retained; new batch path shadow-only | Remediation complete |
| Durable history batch | `device_data` mapper only; other history families absent | Open |
| Incremental bootstrap | Design and plan explicitly defer until scale or measured load | Keep deferred |
| Schema-driven code generation | Superseded by the schema/contract ownership ADR | Reject |
| Network drive | Reviewed design v3.1 and Phase 1 plan v2; no implementation commit found | Excluded from parity execution; edge-local future program |
| Installation recovery | No stable `installation_uuid` recovery model | New work |

The initial OSI Server applier integration test could not start Testcontainers:
the Docker CLI reached server `29.6.1`, but Testcontainers `1.20.5` offered API
`1.32` while the daemon required at least `1.40`. The preparation branch
`AgroLink` resolves `1.21.4` through Spring dependency management. A real
Flyway/Postgres Testcontainers integration test now passes; Task 0 must still
re-run the complete server baseline at the launch head.

## 6. Reuse map

Old checkboxes are not completion evidence. The executor must compare each
plan's promised surface to current code before running it.

| Document | Treatment |
|---|---|
| `docs/superpowers/specs/2026-06-28-sync-architecture-redesign.md` | Architectural source |
| `docs/superpowers/plans/2026-06-28-edge-cloud-history-sync.md` | Partial historical plan; do not replay from its first task |
| `docs/superpowers/plans/2026-06-28-history-sync-review-remediation.md` | Completed safety posture |
| `docs/superpowers/specs/2026-06-30-sync-contract-package-design.md` | Reuse the narrow contract package; keep full DTO generation deferred |
| `docs/superpowers/specs/2026-06-30-schema-driven-codegen-design.md` | Superseded; never execute |
| `docs/superpowers/plans/2026-07-07-sync-ingest-hardening.md` | Completed server foundation |
| `docs/superpowers/plans/2026-07-08-edge-sync-applier-split.md` | Completed first-applier pattern |
| `docs/superpowers/plans/2026-07-08-incremental-bootstrap-snapshots.md` | Deferred by its own trigger condition |
| `docs/superpowers/plans/2026-07-08-outbox-retention-size-cap.md` | Completed |
| `docs/superpowers/plans/2026-07-14-live-gateway-identity-plan.md` | Completed on target; verify after rebase |
| `docs/superpowers/plans/2026-07-15-cross-repo-sync-contract-ci.md` | Reuse after narrowing to current missing gates |
| `docs/superpowers/plans/2026-07-15-device-api-auth-status-repair.md` | Completed |
| `docs/superpowers/plans/2026-07-15-sync-delivery-stop-loss.md` | Core edge portion complete; re-scope remaining protocol work |
| `docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md` | Retain the edge scope model; revise cloud-origin administration |
| `docs/adr/2026-07-19-scoped-multiuser-access-model.md` | Amend because its cloud-administration flip condition has occurred |
| `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-a.md` | Rebase and repair |
| `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-b.md` | Reuse after endpoint inventory refresh |
| `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-c.md` | Reuse after writer/provisioning inventory refresh |
| `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-d.md` | Reuse after current GUI inventory |
| `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-e.md` | Replace with a revised cloud plan |
| `docs/superpowers/specs/2026-07-22-agrolink-network-drive-design.md` | Boundary source only; do not execute in this program |
| `docs/superpowers/plans/2026-07-23-network-drive-phase-1.md` | Reviewed future plan; do not dispatch from parity |

## 7. Dependency order

```text
Verified branch baseline
        |
        +--> Code-derived parity matrix
        |
        +--> Scoped governing-doc refresh
                  |
                  +--> Narrow cross-repo contract CI
                              |
                              +--> Scoped Phase A repair
                                          |
                                          +--> Desired-state/conflict foundation
                                                      |
                                                      +--> Journal cloud parity
                                                                  |
                                                                  +--> Scoped edge reads, writes, and GUI
                                                                              |
                                                                              +--> Scoped cloud enforcement
                                                                                          |
                                                                                          +--> Remaining portable parity

Durable history cutover follows contract governance and mirror coverage.
Installation recovery follows stable account membership and full mirror coverage.
```

Execute the numbered tasks sequentially. An older slice plan may describe
independent or parallel work; this program-level rule overrides it. Scoped
cloud enforcement still waits for contract CI, desired-state handling, and
edge Phases B-D.

## 8. Execution protocol

Every slice follows this loop:

1. Verify the branch base and record both repository SHAs.
2. Read the owning spec, plan, ADR, repository `AGENTS.md`, and applicable
   `osi-*` skills.
3. Recheck the named routes, schemas, and tests against current code.
4. Write or refresh the slice plan when code has drifted.
5. Implement with test-first steps in an isolated worktree.
6. Run the minimum surface gates and the program gates named below.
7. Review the complete slice diff independently.
8. Update the parity matrix and execution report.
9. Commit with an explicit file list and push the integration branch.

Only one slice, worktree mutation, build, or test command may run at a time.
Memory sampling may continue while a long command runs. Do not dispatch
subagents.

### Memory guard

Record `free -m` and the `pswpin`/`pswpout` counters from `/proc/vmstat`
before each slice, before and after every build or full test suite, and at most
30 seconds apart while a heavyweight command runs.

- At 4096 MiB or more `MemAvailable`, run the next command.
- From 2048 to 4095 MiB, launch no new heavyweight command. Let the current
  owned command finish, then wait and recheck.
- Below 2048 MiB, or when available memory falls by more than 1024 MiB across
  two samples while `pswpout` rises, terminate only the heavyweight process
  started by this run. Wait until `MemAvailable` returns to at least 4096 MiB,
  then retry with a narrower command.
- After three 30-second recovery checks without enough memory, mark that
  heavyweight gate resource-blocked, continue lightweight work, and retry it
  before the dependent commit.

Use Gradle with `--no-daemon --max-workers=2`. Limit frontend build heaps with
`NODE_OPTIONS=--max-old-space-size=2048`. Never kill unrelated processes,
clear system caches, disable swap, or start two Docker-backed suites together.

Create and maintain:

- `docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-matrix.md`
- `docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-execution-report.md`

The report records commands, output, exit codes, commit SHAs, reviewed findings,
and deferred risks. A failed base gate is recorded as `red-on-base` and stops the
affected slice.

New cross-repository operations use this rollout:

1. Add the edge-owned schema and fixtures without enabling production.
2. Vendor the exact contract on the server and deploy acceptance code.
3. Prove server acceptance and capability advertisement.
4. Enable the edge producer or cloud command issuer for capable gateways.
5. Enable the user-facing control.

### Launch prerequisites

These conditions are resolved before autonomous Task 0 starts:

- Land this orchestrator file, the reviewed scoped Phase A-E documentation set,
  the final network-drive boundary documents, the matrix, the execution report,
  and the executor prompt on `design-sync/agrolink`.
- Start from a clean integration worktree. The audited AgroLink worktree
  contains generated GUI and locale changes; preserve them outside parity
  commits.
- Confirm the `AgroLink` branch contains the Testcontainers compatibility
  commit and re-run the smoke test:

```bash
cd /home/phil/Repos/osi-server
git switch AgroLink
cd backend
./gradlew test \
  --tests org.osi.server.testsupport.FlywayMigrationIT \
  --no-daemon \
  --max-workers=2
```

Expected: Testcontainers selects `1.21.4`, starts PostgreSQL 16, applies Flyway,
and the test exits zero. A working Docker CLI alone does not clear this gate.

- Record every active program sharing `design-sync/agrolink`, its worktree, and
  its owned files. The network planning program has released ownership. Keep
  the old dirty GUI/locale worktree quarantined.

## 9. Task 0: Rebaseline the launch head

**Files:**

- Create: `docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-matrix.md`
- Create: `docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-execution-report.md`

- [ ] Confirm `design-sync/agrolink` is zero commits behind current
      `origin/main`, or record the maintainer-approved reason for an intentional
      divergence. At this review it is zero behind.
- [ ] Run `git status --short --branch` in both repositories. Do not start from
      a dirty integration worktree.
- [ ] Run `git fetch --all --prune` in both repositories.
- [ ] Record `git rev-parse HEAD`, `git rev-parse origin/main`, and the merge
      base in the execution report.
- [ ] Create OSI Server branch `AgroLink` from verified current `main` if it
      still does not exist.
- [ ] Enumerate edge migrations with
      `ls database/migrations/ordered/`; choose no migration number from an old
      plan.
- [ ] Verify this plan and the reviewed Phase A-E documentation set are tracked
      on `design-sync/agrolink`.
- [ ] Recheck the active-program ownership ledger. Confirm no other program owns
      the same migration manifest, seed, bundled DBs, scope helper, flow nodes,
      locale files, or generated GUI bundle.
- [ ] Inventory edge HTTP routes, edge GUI routes, server controllers, server
      frontend routes, event operations, command operations, resource schemas,
      and feature capabilities into the parity matrix.
- [ ] Classify every surface as `parity`, `edge-only`, `cloud-only`,
      `cloud-missing`, `edge-missing`, `partial`, or `deferred`.
- [ ] Link each non-parity row to an existing implementation plan or the task
      below that creates one.
- [ ] Confirm every linked document is tracked at the recorded edge commit.
      A local file that is absent from `git ls-tree HEAD` is not an
      orchestrator input.

Run the edge baseline:

```bash
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-op-parity.js
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-profile-parity.js
node scripts/verify-trigger-body-parity.js
node scripts/test-journal-schema.js
node scripts/test-outbox-retention.js
node scripts/verify-live-gateway-identity.js
```

Run the server baseline after the launch-prerequisite Testcontainers smoke
passes:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --no-daemon --max-workers=2

cd /home/phil/Repos/osi-server/frontend
export NODE_OPTIONS=--max-old-space-size=2048
npm run test:unit
npm run build
```

Expected result: every command exits zero. If a baseline command fails, stop the
dependent slice and record the exact failure. Do not hide Docker API
incompatibility, a missing daemon, or another test-infrastructure failure as
application behavior or a passing test.

- [ ] Commit only the matrix and execution report:

```bash
git add docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-matrix.md \
  docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-execution-report.md
git diff --cached --check
git commit -m "docs: record AgroLink parity baseline"
git push origin design-sync/agrolink
```

## 10. Task 1: Refresh the scoped governing documents

**Files:**

- Modify: `docs/adr/2026-07-19-scoped-multiuser-access-model.md`
- Modify: `docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md`
- Modify: `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-a.md`

- [ ] Amend the scoped-access ADR: cloud access administration now creates
      pending commands, and the edge remains the authority that applies grants.
- [ ] Preserve per-gateway membership on `LinkedGatewayAccount`; do not change
      the cloud user's global role.
- [ ] Replace Phase A's fixed migration numbers with a rebase instruction that
      chooses the next two free versions. At the audited target, these are
      likely `0033` and `0034`; re-enumeration is mandatory.
- [ ] Update the Phase A plan to use source head `8921e6d1` as cumulative patch
      material. Preserve the accepted `101d1f2f` version contract and
      revalidate every later auth, bootstrap, flag, role, and trigger fix.
- [ ] Run the anti-slop checker on every changed prose file.
- [ ] Review the documents for conflicting authority rules, migration numbers,
      and references to already-completed work.
- [ ] Commit and push the documentation slice only after review.

After Task 1, execute Task 2 and then Task 3. Contract CI is not technically a
prerequisite for the Phase A rebase because `scoped_access_emit` remains off,
but the user selected sequential execution.

## 11. Task 2: Land the narrow cross-repository contract gate

Reuse
`docs/superpowers/plans/2026-07-15-cross-repo-sync-contract-ci.md`, but remove
tasks already delivered by the sync stop-loss work and keep the scope below.

**Required result:**

- The edge owns the event, command, resource, effect-key, and canonicalization
  contract files.
- OSI Server vendors byte-identical copies.
- Both repositories fail CI on mirror drift.
- Golden fixtures cover the operations used by journal, scoped access,
  desired-state conflicts, and command ACK results.
- Capability metadata distinguishes schema acceptance from producer/issuer
  enablement.
- No schema DSL generates SQLite DDL, Flyway DDL, Java entities, or all DTOs.

- [ ] Write failing mirror-drift and missing-operation tests on the server.
- [ ] Add the vendor-copy mechanism and CI gate.
- [ ] Add server parsing tests for every currently enabled edge event and
      command result.
- [ ] Keep the five journal operations staged until the journal-parity slice's
      server acceptance is green.
- [ ] Run edge contract, operation parity, communication contract, and sync-flow
      gates.
- [ ] Run the complete server backend test suite after the launch-prerequisite
      Testcontainers smoke test passes.
- [ ] Commit edge and server changes separately and record both SHAs.
- [ ] Push `design-sync/agrolink` and `AgroLink`.

## 12. Task 3: Repair and integrate scoped-access Phase A

Use `feat/agrolink-scoped-access-phase-a` at `8921e6d1` as a patch source, not
as a merge-ready branch. Commit `101d1f2f` fixes user versioning, while later
commits add credential isolation, bootstrap-race protection, durable flag
provisioning, fresh role checks, and first-assignment-only UUID emission.

**Required corrections:**

- Rebase the code onto the verified `design-sync/agrolink` head.
- Renumber both migrations to the next contiguous free versions.
- Preserve the accepted durable per-user `sync_version` schema and versioned
  `USER_UPSERTED` trigger emission from `101d1f2f`.
- Preserve the same-write increment contract for later role, disabled-state,
  username, and other synced user mutations.
- Keep `scoped_access_emit` off until server acceptance exists.
- Preserve migration-owned triggers; do not add schema behavior to
  `sync-init-fn`.

- [ ] Review the pre-fix failure at `2d3d0c8c` and the corrective diff at
      `101d1f2f`; do not recreate or rewrite an already accepted fix.
- [ ] Update the Phase A migration rehearsal for the rebased versions.
- [ ] Test two successive user mutations and assert increasing versions.
- [ ] Add an edge fixture-level assertion that every emitted user event carries
      a positive version and that later mutations increase it. Server watermark
      conflict behavior belongs to the scoped-cloud slice.
- [ ] Run the complete edge schema gate:

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node scripts/test-journal-schema.js
node scripts/verify-sync-flow.js
```

- [ ] Run the scope-helper, `/api/me`, bootstrap, feature-flag, and profile
      tests named by the refreshed Phase A plan.
- [ ] Review the cumulative diff against current AgroLink, not against the old
      Phase A base.
- [ ] Commit and push Phase A.
- [ ] Record `SCOPED_PHASE_A_READY` with the edge SHA in the execution report.
      The future network-drive program may consume this signal in a separate
      run.

## 13. Task 4: Add durable cloud desired state and conflict handling

This slice runs on OSI Server. It reuses existing pending commands and command
status rather than creating a parallel queue.

**Planning files:**

- Create: `docs/superpowers/specs/2026-07-23-cloud-desired-state-design.md`
- Create: `docs/superpowers/plans/2026-07-23-cloud-desired-state.md`

**Behavioral contract:**

- A cloud mutation records the desired resource state and the canonical
  `base_sync_version`.
- The API returns the desired representation and operation state immediately.
- A later edit to the same resource supersedes or coalesces a safe unleased
  config command; it never rewrites a leased command or a physical effect.
- Edge ACK and later mirror events move the operation to `applied`.
- Version mismatch moves it to `conflicted` with canonical and desired values.
- Terminal edge rejection moves it to `rejected` with a stable reason.
- Physical-effect expiry moves it to `expired`.
- Retries preserve command UUID and effect key.

- [ ] Recheck current pending-command entities, leases, ACK handling, controller
      responses, and frontend normalization before drafting.
- [ ] Write and review the desired-state design and implementation plan. Bind
      them to the state machine above and existing pending-command storage.
- [ ] Do not start implementation until both documents pass self-review and an
      independent technical review.
- [ ] Execute the approved desired-state plan with unit tests for every state
      transition.
- [ ] Add integration tests for command creation, edge ACK, mirror convergence,
      conflict, supersession, retry, and expiry.
- [ ] Extend the server frontend API bridge; normalization stays in
      `frontend/src/services/api.ts`.
- [ ] Add reusable pending-state UI primitives for zone and journal edits.
- [ ] Run backend tests plus server frontend unit tests and build.
- [ ] Commit and push the server slice.

## 14. Task 5: Implement journal parity on OSI Server

The five edge event operations and five edge command handlers are the source
model. Do not redesign journal semantics on the server.

**Planning files:**

- Create: `docs/superpowers/specs/2026-07-23-journal-server-parity-design.md`
- Create: `docs/superpowers/plans/2026-07-23-journal-server-parity.md`

**Required operations:**

- Journal entry upsert and void
- Vocabulary upsert
- Plot upsert
- Plot-group upsert

**Required result:**

- Flyway-owned cloud mirror tables and indexes
- Per-resource event appliers with stale-version and tombstone handling
- Cloud API and React workflows matching portable edge behavior
- Pending-command issuance for cloud edits
- Immediate desired-state rendering
- Background convergence, conflict display, retry, and rejection recovery
- Account and plot scope hooks ready for Task 7

- [ ] Recheck the current edge journal schema, event payloads, command
      handlers, exports, and validation fixtures before drafting.
- [ ] Write and review the journal-server design and implementation plan.
      Reference the existing edge operations rather than restating their domain
      rules from memory.
- [ ] Execute the approved journal-server parity plan.
- [ ] Keep journal capabilities disabled for a gateway until server acceptance
      and command issuance are both green.
- [ ] Test edge event replay, duplicate delivery, stale delivery, tombstones,
      cloud edit, conflict, void, and continued editing while pending.
- [ ] Compare journal exports and validation rules against edge fixtures.
- [ ] Run edge contract gates and complete server backend/frontend gates.
- [ ] Remove `cloudDeferred` staging only for operations proven end to end.
- [ ] Commit and push paired slices.

## 15. Task 6: Execute scoped-access Phases B-D on the edge

Refresh the existing plans against the current route inventory before editing
flows or React code:

- Phase B: read-path enforcement
- Phase C: write-path, physical-effect, provisioning, account/grant, scheduler,
  and audit enforcement
- Phase D: GUI scope, roles, account/grant administration, and viewer behavior

The existing ownership-plus-grant union remains binding. Weather-class devices
are shared reads. Physical and privilege paths use fresh membership checks.
Out-of-scope resources return 404; wrong-role actions return 403.

- [ ] Regenerate the route inventory and account for journal routes added since
      the old plans were written.
- [ ] Verify device provisioning is treated as an existing path requiring
      authorization, not a new feature.
- [ ] Preserve the single `osiLib.require('scope')` module instance; do not
      introduce direct helper loads that split its cache.
- [ ] Close the accepted Phase A `/api/me` and bootstrap test gaps while their
      read/write consumers are added.
- [ ] Execute B, C, and D as separate reviewed commits.
- [ ] Run all flow parse, silent-catch, size, bare-require, wiring, profile, and
      sync-flow gates after each flow integration.
- [ ] Run GUI typecheck, unit tests, and build after each GUI integration.
- [ ] Keep flag-off behavior unchanged.
- [ ] Commit and push each phase only when its matrix is green.

## 16. Task 7: Implement scoped access and cloud administration on OSI Server

Revise the server design and Phase E plan after desired-state handling and edge
Phases B-D are concrete.

**Planning files:**

- Modify: `docs/superpowers/specs/2026-07-19-agrolink-scoped-access-osi-server.md`
- Modify: `docs/superpowers/plans/2026-07-19-agrolink-scoped-access-phase-e.md`

**Required result:**

- Per-gateway role and enabled state on or beside `LinkedGatewayAccount`
- Mirrored user, zone-assignment, and plot-assignment resources
- Server authorization using local `user_uuid` within the selected gateway
- No privilege derived from the cloud user's global role
- Cloud user/role/grant edits issued as versioned pending commands
- Edge application followed by mirror confirmation
- Immediate desired-state UI with pending/conflict/rejected status
- Immediate denial for disabled memberships on privilege and effect paths
- Multiple linked installations remain separate and switchable

- [ ] Recheck the current `LinkedGatewayAccount`, server authorization,
      mirrored-resource, and pending-command code.
- [ ] Rewrite and review the server spec and Phase E plan around
      cloud-originated pending access commands.
- [ ] Deploy server acceptance before enabling edge scoped-access producers.
- [ ] Test equal-version/different-payload watermark rejection at the server
      boundary and the resulting recoverable conflict state.
- [ ] Resolve or explicitly deduplicate the accepted no-op
      `USER_UPSERTED` double-emission before enabling scoped producers.
- [ ] Test a cloud user who is admin on one gateway and viewer on another.
- [ ] Test grant, revoke, disable, re-enable, last-admin protection, concurrent
      edit conflict, and offline edge recovery.
- [ ] Test that a cloud-originated revoke does not claim success until the edge
      applies it.
- [ ] Enable producers and command issuers only for gateways advertising the
      required capability.
- [ ] Run paired contract, backend, frontend, edge sync, and edge scope suites.
- [ ] Commit and push paired slices.

## 17. Task 8: Close the remaining portable parity matrix

Work from the matrix produced in Task 0. Do not infer missing features from old
issue titles.

Process rows in this order:

1. Zone lifecycle, location, configuration, and soil profile
2. Schedules and irrigation calibration
3. Device assignment, supported flags, and supported device configuration
4. Portable history views, exports, analysis, and settings
5. Remaining account-scoped read and mutation workflows

For each row:

- [ ] Reproduce edge behavior and name the canonical edge route/service.
- [ ] Classify hardware-dependent fields and omit or render them read-only on
      the cloud.
- [ ] Add or reuse a versioned event and pending command when mutation is
      portable.
- [ ] Use desired state for immediate cloud UX.
- [ ] Add edge, server, and frontend tests for the same scenarios.
- [ ] Update the matrix with evidence and commit SHAs.
- [ ] Mark the row `parity` only after edge-to-cloud and cloud-to-edge
      convergence both pass.

The supported device catalog is limited to the six devices in the resolved
decision table. UC512 remains accepted in stored schema where required for
backward compatibility but is not advertised as a supported AgroLink device.

## 18. Task 9: Make history batch durable without removing the legacy path

Reuse the deferred “Durable History Batch Cutover” portion of the history
architecture. Keep incremental bootstrap deferred.

**Required coverage:**

- Canonical `device_data`
- Chameleon raw/diagnostic history
- Dendrometer history
- Derived zone environment history
- Irrigation and actuation history needed for parity and recovery

- [ ] Define a mapper and idempotency key for every history family.
- [ ] Run shadow comparison against the existing durable event/bootstrap mirror.
- [ ] Backfill bounded ranges and compare counts, keys, hashes, and tombstones.
- [ ] Exercise retry, duplicate, out-of-order, interruption, and cursor restart.
- [ ] Promote batch ingestion to durable only after measured parity is green.
- [ ] Keep the legacy durable path enabled.
- [ ] Do not add server retention that deletes canonical mirrored history.
- [ ] Update `docs/sync/history-sync-v1.md`, the parity matrix, and the execution
      report with measured evidence.

## 19. Task 10: Add installation-bound recovery

Execute only after scoped membership and mirror coverage are stable.

**Planning files:**

- Create: `docs/superpowers/specs/2026-07-23-installation-recovery-design.md`
- Create: `docs/superpowers/plans/2026-07-23-installation-recovery.md`

**Required result:**

- Stable `installation_uuid` survives gateway EUI replacement
- Existing operational aggregates continue to use gateway EUI
- Installation records retain current and previous gateway EUIs
- Offline verifier v2 binds to installation identity
- Recovery bundles are encrypted before durable cloud storage
- Server envelope encryption separates data keys from bundle ciphertext
- Restore has preview, explicit target installation, audit, and rollback
- A recovered edge reconciles before accepting new canonical writes

- [ ] Recheck the final account membership, gateway EUI migration, link,
      verifier, history mirror, and server encryption facilities before
      drafting. Do not base recovery on the 2026-07-23 pre-parity model.
- [ ] Write and review the recovery design and implementation plan.
- [ ] Execute the approved recovery design and plan using test keys and local
      storage first.
- [ ] Add migration and compatibility tests for verifier v1 to v2.
- [ ] Test EUI replacement, reinstall, partial bundle, wrong installation,
      wrong key, stale bundle, and interrupted restore.
- [ ] Stop before selecting or provisioning an external key service not already
      approved.
- [ ] Do not perform a live restore or production upload.
- [ ] Commit and push reviewed local/test infrastructure only.

## 20. Task 11: Program verification and handoff

- [ ] Re-run every edge baseline command from Task 0.
- [ ] Run edge GUI typecheck, unit tests, and build.
- [ ] Run the complete OSI Server backend and frontend suites with Docker
      available.
- [ ] Run sync chaos/soak coverage with disconnect, replay, stale version,
      expired effect, edge restart, and server restart scenarios.
- [ ] Confirm the parity matrix has no unexplained `partial`,
      `cloud-missing`, or `edge-missing` portable workflows.
- [ ] Confirm edge-only and cloud-only rows have a written reason.
- [ ] Confirm all gateways without new capabilities retain old behavior.
- [ ] Confirm the network-drive feature remained edge-local and its files were
      not folded into parity commits.
- [ ] Run the anti-slop checker on all changed documentation.
- [ ] Run `git diff --check` and `git status --short --branch` in both
      integration worktrees.
- [ ] Push both branches.
- [ ] End the execution report with remaining risks, deferred history
      decommissioning, external recovery-key decisions, skipped production
      tests, and exact branch SHAs.

## 21. Block and continue conditions

The autonomous executor records the affected slice as blocked and continues
with the next independent sequential task when:

- The maintainer's `main` transfer is incomplete or the integration branch is
  dirty.
- A referenced plan or contract file exists only as an untracked local file and
  is not part of the reviewed branch state.
- The next migration number changes or another active program owns the same
  seed, manifest, bundled DB, helper, flow node, locale file, or generated GUI
  output.
- A required gate is red on the branch base.
- Server integration tests cannot run because the Docker daemon is missing,
  Testcontainers cannot negotiate a supported API, or another declared test
  dependency is unavailable.
- A change would require production or `osicloud.ch` access.
- Agroscope IT input is required for SMB, ACL, service-account, CSV-format, or
  real-share behavior.
- A recovery key provider requires a new external service, account, credential,
  or cost.
- A proposal changes edge authority, default separate accounts, per-gateway
  roles, or the six-device baseline.
- A history step disables the legacy durable path or deletes mirrored history.
- A physical-effect command cannot prove idempotency and expiry behavior.
- Contract acceptance and producer/issuer enablement cannot be deployed
  separately.

Do not ask the user for a prompt, preference, approval, or permission during
the run. Use the locked decisions and the least-destructive local default. Do
not broaden authority to escape a condition. Retry blocked work after later
tasks when the dependency may have changed. End with a blocked result only
after every remaining task depends on an unresolved condition; the report then
states the evidence and smallest missing external decision.

## 22. Definition of done

The program is complete when:

- Every portable matrix row is proven at parity or has a maintainer-approved
  deferral.
- Journal and zone edits render immediately in the cloud and converge in the
  background.
- Conflicts and rejections are recoverable without hiding canonical edge state.
- Scoped roles and grants enforce the same resource boundaries on edge and
  cloud.
- Cloud access administration passes through pending edge-approved commands.
- All six supported device families have matching portable workflows.
- Durable history batch coverage includes every declared history family.
- Recovery is installation-bound and tested without relying on a fixed gateway
  EUI.
- Edge-only hardware and network-drive behavior remains isolated.
- Both integration branches are committed, pushed, and green at their declared
  gates.
