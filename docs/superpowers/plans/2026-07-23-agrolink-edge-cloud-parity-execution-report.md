# AgroLink edge/cloud parity execution report

## Preparation record: 2026-07-23

**State:** Tasks 0 through 3 complete and pushed. Launch heads were fetched,
base gates run, one server frontend base defect repaired, the route/contract
inventory regenerated, the scoped-access governing documents reconciled, and
the cross-repository contract gate and edge scoped-access foundation landed.

### Repository bases

| Repository | Branch/worktree | Base |
|---|---|---|
| OSI OS integration | `design-sync/agrolink` in `.worktrees/agrolink-parity-orchestrator-prep` | `6a4271b0d502cab0bdcdba76b1eb0353e49fcce9` |
| OSI OS preparation source | `docs/agrolink-parity-orchestrator-prep` | `5fc265bb` |
| OSI OS `origin/main` | audited merge base | `b31825becbb8abcef86cfad9dc756cd2e351f135` |
| OSI Server | `AgroLink` in `.worktrees/agrolink` | `3179df875204ac2c9d38e6d9c96cb2beaa15a1b4` |
| OSI Server `origin/main` | branch source and merge base | `8cac33d3a8a210784fa5f9b73c8e4dfe796203f7` |

After `git fetch --all --prune`, the edge target is 221 commits ahead and zero
behind `origin/main`; its merge base is the current `origin/main`. Server
`AgroLink` is two commits ahead and zero behind its current `origin/main`.

### Inputs consolidated

- The orchestrator program incorporates the current code audit, reuse map,
  resolved product decisions, external review findings, block conditions, and
  launch gates.
- Phase A source head `8921e6d1` contains the accepted `101d1f2f` user-version
  fix plus later auth, bootstrap, flag, role, and trigger corrections. Treat
  the cumulative diff as patch material and revalidate it. Its original
  migration numbers conflict with target migrations through `0032`.
- The newer reviewed Phase B-D documents are included.
- Phase E is retained as historical input and marked superseded because cloud
  access administration is now required through edge-approved commands.
- Network-drive design v3.1 and its Phase 1 plan v2 are tracked as boundary
  inputs. No implementation commit exists, and parity must not execute them.
- The launch parity matrix now contains the route and contract inventory
  regenerated from code.

### Verification evidence

| Command | Result |
|---|---|
| `node scripts/verify-sync-contract.js` | exit 0; `verify-sync-contract: OK` |
| `node scripts/test-contract-schemas.js` | exit 0; `PASS: contract schema checks pass` |
| `node scripts/verify-sync-op-parity.js` | exit 0; 17 flow, 18 seed/server, and 23 schema operations |
| `node scripts/verify-sync-flow.js` | exit 0; sync verification and chained profile parity passed |
| `node scripts/verify-no-new-silent-catch.js` | exit 0; 213 per profile equals the ratchet |
| `node scripts/verify-profile-parity.js` | exit 0; `All parity checks passed.` |
| `node scripts/verify-trigger-body-parity.js` | exit 0; both profiles match the seed |
| `node scripts/test-journal-schema.js` | exit 0; catalog, FK, replay, and seven-DB parity passed |
| `node scripts/test-outbox-retention.js` | exit 0; 6 tests passed |
| `node scripts/verify-live-gateway-identity.js` | exit 0; live identity verification passed |
| OSI Server Testcontainers dependency insight | PASS: `org.testcontainers:testcontainers:1.21.4` selected |
| `./gradlew test --tests org.osi.server.sync.GatewayLocationApplierIT --tests org.osi.server.sync.SyncEventApplierTest --no-daemon --max-workers=2` | exit 0; `BUILD SUCCESSFUL in 16s` |
| `./gradlew test --no-daemon --max-workers=2` | exit 0; `BUILD SUCCESSFUL in 1m` |
| `npm run test:unit` before repair | exit 1; 263 passed, stale frontend manifest hash pin failed |
| `npx vitest run src/channels/__tests__/channels.parity.test.ts` after repair | exit 0; 1 test passed |
| `OSI_OS_REPO=… node scripts/verify-channel-manifest-sync.js` | exit 0; edge and both server copies hash to `66b99314…` |
| `npm run test:unit` after review | exit 0; 65 files and 264 tests passed |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run build` after review | exit 0; 1,725 modules transformed |

The first server attempt failed before application assertions because Spring
Boot selected Testcontainers `1.20.5`, whose Docker client offered API `1.32`
to Docker Engine `29.6.1`, which requires at least `1.40`. Adding a second BOM
did not override Spring dependency management. Setting
`testcontainers.version=1.21.4` through the Spring-managed Gradle property
changed the resolved dependency and cleared the real integration test.

### Task 0 server baseline repair

The full frontend baseline exposed a stale test constant. Commit `7aba2a7`
updated the edge-aligned manifest, both server copies, the backend test pin,
and `scripts/verify-channel-manifest-sync.js` to SHA-256 `66b99314…`; it left
`frontend/src/channels/__tests__/channels.parity.test.ts` pinned to the prior
bytes.

The repair changed only that constant. A separate diff review found no
generated output or behavior change. Commit
`3179df875204ac2c9d38e6d9c96cb2beaa15a1b4` was pushed to `AgroLink`, and
`git ls-remote --exit-code origin refs/heads/AgroLink` returned the same SHA.

### Task 1 scoped governance refresh

The ADR and scoped design now distinguish a cloud request from canonical edge
state. Cloud access administration saves durable desired state and queues a
versioned REST pending command. The edge checks the version precondition,
applies or rejects the request, and emits the canonical mirror event. The
cloud's global `User.role` remains outside this model; role and enabled state
stay per gateway on the `LinkedGatewayAccount` axis.

The Phase A plan now derives the next two free migration versions from the
target head and carries those selected filenames through rehearsals,
checksums, bundled databases, and commits. It treats `8921e6d1` as cumulative
patch material and preserves the accepted `101d1f2f` contract: durable
`users.sync_version`, writer increments in the same synced mutation, and
trigger emission from `NEW.sync_version`. The refreshed acceptance test also
requires positive initial versions, two increasing user mutations, and the
first-assignment-only user UUID trigger guard.

The anti-slop checker passed on all three governing files, `git diff --check`
passed, and a separate full-diff review found no remaining executable
references to the source migration numbers or conflicting authority rules.
Commit `459cf73f010a390c10b6dbb707de891f0179775e` was pushed to
`design-sync/agrolink`; `git ls-remote --exit-code origin
refs/heads/design-sync/agrolink` returned the same SHA.

### Task 2 cross-repository contract gate

OSI OS now owns six canonical contract files: the command, event, and resource
schemas; effect-key and canonicalization rules; and a golden rollout fixture.
The fixture records accepted, enabled, and staged event and command sets plus
the command ACK result vocabulary. Schema acceptance is independent from edge
producer and cloud issuer enablement. Five journal event and command operations
remain staged. Five scoped-access events are newly accepted but remain disabled
on both sides. `CONFLICT` is accepted as a future ACK result but its server
handler remains disabled.

The first server tests were intentionally red. The vendor mutation test exited
127 because its verifier did not exist, and
`SyncContractVendorTest` failed two of three tests because the vendored
resources did not exist. The completed implementation vendors all six files
under `backend/src/test/resources/sync-contract/`, compares every byte against
the edge checkout, tests each drift and missing-file case, parses every
accepted event into `EdgeSyncService.SyncEventRecord`, and parses and
serializes every golden ACK through the server request and response DTOs.

Edge CI now runs the canonical contract and schema-fixture gates. Server CI
checks out `osi-os` at `design-sync/agrolink`, runs the mutation test, and
rejects a missing, empty, or byte-different vendor. The server guidance records
that this temporary integration ref must switch to `osi-os/main` when the
branch merges.

Task 2 verification:

| Command | Result |
|---|---|
| `node scripts/verify-sync-contract.js` | exit 0; 28 accepted event operations and rollout metadata verified |
| `node scripts/test-contract-schemas.js` | exit 0; exact journal and scoped staging sets verified |
| `OSI_SERVER_EDGE_SYNC_SERVICE=… node scripts/verify-sync-op-parity.js` | exit 0; 18 enabled server operations and 10 staged operations |
| `node scripts/verify-communication-contract.js` | exit 0 |
| `node scripts/verify-sync-flow.js` | exit 0; chained schema, flow, and profile gates passed |
| `sh scripts/verify-edge-sync-contract-vendor.test.sh` | exit 0; all six drift cases and a missing vendor fail closed |
| `EDGE_CONTRACT_ROOT=… sh scripts/verify-edge-sync-contract-vendor.sh` | exit 0; six vendors byte-identical |
| `./gradlew test --tests org.osi.server.sync.SyncContractVendorTest --no-daemon --max-workers=2 -x buildFrontend -x buildTerraIntelligenceFrontend` | exit 0 after the expected red run |
| `NODE_OPTIONS=--max-old-space-size=2048 ./gradlew test --tests org.osi.server.sync.GatewayLocationApplierIT --tests org.osi.server.sync.SyncEventApplierTest --no-daemon --max-workers=2` | exit 0; `BUILD SUCCESSFUL in 37s` |
| `NODE_OPTIONS=--max-old-space-size=2048 ./gradlew test --no-daemon --max-workers=2` | exit 0; `BUILD SUCCESSFUL in 1m 1s` |

The first targeted integration-smoke invocation entered its frontend build
without the required Node heap guard. It was terminated before completion and
rerun with `NODE_OPTIONS=--max-old-space-size=2048`; the guarded run passed.
No application failure was hidden.

Edge commit `8a06e630bd9dadc315c917f18850a19a1959e930` and server commit
`04e60bf669cfd02c4ac756ddf956b8b8acefa8bf` were pushed separately. Remote
branch lookups returned the same SHAs.

### Task 3 scoped-access Phase A

`SCOPED_PHASE_A_READY=4eb055229b31ecfedb41478b9f7a316b09e09e58`

The rebased schema uses migrations `0033` and `0034`. The schema migration
adds durable positive user and assignment versions, seven migration-owned
outbox triggers, and the disabled `scoped_access_emit` gate. The data migration
backfills identifiers and versions and promotes the lowest-id active user to
admin in the same versioned write. The user trigger emits `NEW.sync_version`;
the user UUID trigger only fires on the first assignment.

The registered `osi-scope-helper` resolves admin, zone, and plot scope and
supports a fresh-role check that does not trust a stale cached admin role.
The flow slice adds `/api/me`, exposes `scoped_access` through
`/api/system/features`, persists the disabled-by-default UCI flag into the
Node-RED environment, and keeps registration and login credentials on the
request message. Scoped bootstrap uses one conditional insert and its own
change count, so a same-username race loser returns 403. Disabled scoped users
cannot obtain new tokens.

The first auth harness run was intentionally red: all four tests reproduced
credential cross-contamination, registration identity replacement, bootstrap
race handling, and disabled-user token issuance. The completed implementation
passes all four. The full sweep also exposed two stale test contracts. The
journal feature response expected the old exact object; it now checks
`scoped_access` in both flag states. The seed replay found that the fresh
`users` declaration did not match SQLite's stored DDL after three
`ALTER TABLE ... ADD COLUMN` operations; the seed now matches the replayed
fingerprint.

Task 3 verification:

| Command | Result |
|---|---|
| `node scripts/verify-migrations.js` | exit 0; 34 migrations and checksum manifest verified |
| `node scripts/verify-seed-replay.js` | exit 0; replay matches `seed-blank.sql` |
| `node scripts/verify-runtime-schema-parity.js` | exit 0 |
| `node scripts/verify-db-schema-consistency.js` | exit 0; all seven bundled databases passed |
| `node scripts/verify-no-stray-ddl.js` | exit 0 |
| `node scripts/verify-profile-parity.js` | exit 0 |
| `node scripts/verify-boot-ddl-interpolation.js` | exit 0 |
| `node scripts/verify-trigger-body-parity.js` | exit 0 |
| `node scripts/test-journal-schema.js` | exit 0 |
| `node scripts/verify-sync-flow.js` | exit 0 |
| `node --test scripts/rehearse-scoped-access-migration.test.js` | exit 0; 8 tests passed |
| `node --test scripts/rehearse-scoped-trigger-boot-survival.test.js` | exit 0; 2 tests passed |
| `node --test .../osi-scope-helper/index.test.js` | exit 0; 8 tests passed |
| `node --test scripts/test-auth-credential-isolation.js` | exit 0; 4 tests passed |
| `node scripts/test-flows-wiring.js` | exit 0; 62 journal/bootstrap cases and aggregate wiring passed |
| Flow parse, bare-require, size, silent-catch, MQTT, and helper-registration gates | exit 0 |

Commits `1f6f0933` (schema), `d5882543` (scope helper), and `4eb05522`
(auth, API, durable flag, and tests) were pushed to `design-sync/agrolink`.
The remote branch resolved to the same Phase A head.

### Memory samples

Every heavyweight command started above the 4,096 MiB threshold. Recorded
`MemAvailable` values ranged from 12,942 MiB to 14,155 MiB. During the
one-minute backend suite, availability fell by 705 MiB between the first two
samples while `pswpout` rose, below the 1,024 MiB termination threshold. No
owned process was terminated. Task 1 prose verification started with 14,113
MiB available.

Task 2 pre-command samples recorded between 14,631 MiB and 15,092 MiB
available. The final sample after both pushes recorded 14,655 MiB available,
`pswpin 720618313`, and `pswpout 881901826`. The earlier Task 2 samples omitted
the required `/proc/vmstat` counters; this is an evidence gap, not an inferred
zero-swap claim. The only terminated process was the owned, unguarded targeted
Gradle invocation described above.

Task 3 samples recorded between 13,638 MiB and 14,812 MiB available. The final
heavyweight sample before `verify-sync-flow.js` recorded 13,638 MiB available,
`pswpin 721693780`, and `pswpout 883231112`. Every sample cleared the 4,096 MiB
gate.

### Program ownership

The network planning program is finished. Its final local commit is `8f73306f`
and contains the reviewed design and Phase 1 plan. A search of all refs found no
network-drive schema, helper, flow, or implementation commit. Those future
files remain outside the parity program.

The old target worktree `/home/phil/Repos/osi-os-agrolink` still contains
unrelated generated GUI assets and locale changes. It is detached at
`f5ca4a1f` and quarantined rather than cleaned or staged. The executor must
work from the clean integration worktree and must not absorb those files.

The active i18n worktree reserves locale files, and detached build worktrees
retain generated GUI assets. Task 0 does not touch those files. Task 6 must
recheck ownership before any locale or generated-bundle mutation.

### Task 0 inventory

The live matrix now records:

- 118 edge HTTP nodes and 14 edge GUI routes;
- 24 server controller classes with 150 mapped methods and 13 server GUI
  routes;
- 28 accepted event operations, 40 command types, and 18 non-primitive resource
  schema definitions;
- 18 enabled event operations, five staged journal events, five staged
  scoped-access events, and explicit acceptance-versus-enablement metadata.

All orchestrator, cross-contract, and Phase A-E documents referenced by the
program are present in `git ls-tree -r --name-only HEAD`. Ordered edge
migrations end at `0032__journal_catalog_v10.sql`; Task 3 must allocate the
next two free versions after another fetch and ownership check.

No production host, live gateway, external key provider, or AgroLink SMB share
was accessed.
