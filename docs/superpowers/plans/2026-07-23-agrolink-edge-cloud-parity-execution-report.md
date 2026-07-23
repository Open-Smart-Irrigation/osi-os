# AgroLink edge/cloud parity execution report

## Preparation record: 2026-07-23

**State:** Tasks 0 through 5 complete and pushed. Launch heads were fetched,
base gates run, one server frontend base defect repaired, the route/contract
inventory regenerated, the scoped-access governing documents reconciled, the
cross-repository contract gate and edge scoped-access foundation landed, and
the cloud desired-state ledger now reconciles command ACKs with edge mirrors.
The five journal event and command operations are enabled end to end, with
cloud mirrors, queued edits, exports, and a responsive journal workspace.

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

### Task 4 cloud desired state

The server now records each cloud-originated desired effect in
`desired_state_operations`. Configuration commands may coalesce only while an
unleased operation is pending or sent; physical effects remain immutable and
require a future expiry. Retry and coalescing preserve command identity,
event UUID, and effect key.

Command ACKs and accepted edge mirror events reconcile the same operation in
either order. An operation reaches `APPLIED` only after an `APPLIED` ACK and a
recursive subset match against the canonical edge mirror. Mismatches become
`CONFLICTED`; rejected and expired operations stay terminal. Duplicate, stale,
rejected, and retryable sync events do not advance convergence.

Zone configuration is the first consumer. Its API creates the durable
operation, exposes creator-authorized status, and overlays non-applied desired
values without presenting them as canonical edge state. The React zone card
shows an accessible pending-state notice and normalizes snake-case and
camel-case API forms. All seven locale catalogs carry the new copy.

The implementation review found that edge events encode
`prediction_card_enabled` as `0` or `1` and do not mirror the cloud-only
weather-source field. The desired subset was corrected to use the numeric
representation and exclude weather source, avoiding false conflicts. A full
architecture run also detected the new package's participation in the
existing frozen core-package cycle. The ArchUnit baseline was regenerated
once with store creation enabled, then locked again; the architecture gate
passes with store creation disabled.

Task 4 verification:

| Command | Result |
|---|---|
| Focused desired-state integration selection | exit 0 |
| `NODE_OPTIONS=--max-old-space-size=2048 ./gradlew test --no-daemon --max-workers=2` | exit 0; 1,091 tests, `BUILD SUCCESSFUL in 1m 13s` |
| Final architecture and desired-state selection | exit 0; `BUILD SUCCESSFUL in 19s` |
| `npm run test:unit` | exit 0; TAP 45 tests plus 67 Vitest files and 270 tests passed |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run build` | exit 0; 1,725 modules transformed |
| `git diff --check origin/AgroLink...HEAD` | exit 0 |

Server commits `7c009da` through
`b86473e88a173f68ef04c39f9265a2837887cfc0` were pushed to `AgroLink`.
Governing design and plan commits `412267fe`, `722fd160`, and `ce19950b`
were pushed to `design-sync/agrolink`.

### Task 5 journal parity

The cloud now mirrors journal entries, vocabulary, plots, and plot groups in
four Flyway-owned JSONB aggregate tables with selected indexed fields. Five
per-resource appliers enforce gateway identity, replay idempotence, monotonic
versions, equal-version equality, tombstones, and desired-state convergence.
The event dispatcher maps each journal operation to its actual resource type
and key, so watermarks and desired-state observations share the canonical
aggregate identity.

Cloud mutations issue the exact five edge commands through the Task 4 desired
state ledger. The server overwrites owner, author, gateway, origin, status,
target version, and effect-key fields from the authenticated link context.
The trusted command owner is the gateway-local user UUID rather than the cloud
user UUID. Commands use canonical `command_type`; the legacy camel-case alias
is suppressed when that field is present.

Gateway-scoped journal APIs expose canonical mirrors alongside the latest
desired operation. Unsupported gateways remain readable but cannot accept
mutations until bootstrap advertises `field_journal_v1`. Linked-gateway
summaries now expose that capability to the UI. JSON export returns canonical
entry aggregates. CSV export is UTF-8 with a BOM, uses CRLF records, and
protects spreadsheet formula cells.

The `/journal` workspace selects among linked gateways, overlays desired
values immediately, keeps pending edits on the unchanged canonical base
version, shows conflict and rejection detail, supports edit-and-resubmit
recovery, and leaves retryable failures on the automatic command lease path.
New cloud records are final-only. Plot, plot-group, and custom-vocabulary
forms build the complete portable resource shapes expected by edge command
validation. JSON and CSV downloads, dashboard navigation, responsive layouts,
and matching keys in all seven locale catalogs are included.

The contract rollout removed the five journal commands from
`commands.cloudDeferred` and the five journal events from
`eventOps.cloudDeferred`. Journal module ownership remains an audited closed
set. The five scoped-access events remain deferred on the cloud axis; their
already-shipped Phase A producers are allowed behind the rollout flag.

The first frontend API and route tests were intentionally red because
`journalAPI` and `/journal` did not exist. The first linked-gateway summary
test failed to compile because `fieldJournalSupported` was not exposed. The
first promoted parity test failed because the verifier still excluded journal
server handlers. Each failure cleared after the corresponding implementation.
One Gradle command was invoked from the server repository root and exited 127
because the wrapper lives in `backend/`; it was immediately rerun from the
correct directory. No application failure was hidden.

Task 5 verification:

| Command | Result |
|---|---|
| `node --test scripts/verify-sync-op-parity.test.js` with the server source override | exit 0; 44 tests passed |
| `node scripts/verify-sync-contract.js` | exit 0; 40 command types, journal enabled, golden rollout verified |
| `node scripts/verify-sync-op-parity.js` with the server source override | exit 0; 23 enabled server operations, scoped operations cloud-deferred |
| `node scripts/test-contract-schemas.js` | exit 0; canonical journal command and aggregate fixtures passed |
| Focused server journal, vendor, and linked-gateway selection | exit 0; `BUILD SUCCESSFUL in 55s` |
| `NODE_OPTIONS=--max-old-space-size=2048 ./gradlew test --no-daemon --max-workers=2` | exit 0; 1,105 tests, no failures or skips, `BUILD SUCCESSFUL in 1m 26s` |
| `npm run test:unit` | exit 0; TAP 45 tests plus 71 Vitest files and 278 tests passed |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run build` | exit 0; 1,729 modules transformed |
| `node .claude/skills/anti-slop-writing/slop-check.js` on journal locale copy | exit 0 |
| `git diff --check` in both repositories | exit 0 |

The edge design commit `6fd5d7fd`, contract rollout commit `af274c9c`, and
server commits `4bf1c67` through `1c953c7` were pushed to their target
branches. The vendored golden fixture is byte-identical to the canonical edge
fixture. No production host, live gateway, or external network drive was
accessed.

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

Task 4 samples recorded between 13,907 MiB and 14,148 MiB available. The final
full backend suite started with 13,920 MiB available. Every sample included
the swap counters and cleared the 4,096 MiB gate.

Task 5 samples recorded between 12,172 MiB and 13,442 MiB available. The final
frontend build started with 13,217 MiB available,
`pswpin 726934797`, and `pswpout 892359280`. Every heavyweight command cleared
the 4,096 MiB gate.

### Task 6 scoped edge access

Phase B applies the owner-plus-grant union to zone, device, history, analysis,
environment, recent-actuation, and journal reads. Weather-class devices remain
shared reads. Phase C applies fresh role and membership checks to every
portable write, physical effect, provisioning route, scheduler path, system
write, account mutation, and grant mutation. Out-of-scope resources remain
indistinguishable from missing resources; wrong-role actions return 403.

Phase D loads `/api/me` once per authenticated session and filters zone and
plot navigation while scope is unresolved. Viewer sessions retain scoped data
but do not render mutation controls or settings. Scoped administrators receive
user lifecycle and grant-management routes. The edge grant contract can
create and revoke zone or plot assignments but cannot list assignments, so the
GUI identifies that limitation and shows only grants created during the
current page session. Existing grant enumeration remains a contract gap for
Task 7.

The active `.worktrees/i18n-review-repairs` worktree still owns the locale
trees. Phase D's locale step was therefore blocked under the program ownership
rule. New administration and disabled-account copy remains English source
text; no locale or generated feed file was edited.

Task 6 verification:

| Command | Result |
|---|---|
| `node scripts/test-scoped-access-writes.js` | exit 0; 24 tests passed |
| `node scripts/test-scoped-access-reads.js` | exit 0; 23 tests passed |
| `node --test scripts/test-scope-helper.js` | exit 0; 20 tests passed |
| Flow parse, wiring, size, silent-catch, bare-require, profile, runtime-schema, MQTT, and sync gates | exit 0 |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run typecheck` | exit 0 |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run test:unit` | exit 0; 94 TSX-runner tests and 1,663 Vitest tests passed |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run build` | exit 0; 1,711 modules transformed |
| `git diff --check` | exit 0 |

Phase B is edge commit `31fd939d`. Phase C spans `b279d932` through
`f712efb9`. Phase D spans `19d68c12` through `b4b6c1a8`. All commits were
pushed to `design-sync/agrolink`.

The final GUI gate started with 12,575 MiB available,
`pswpin 730460840`, and `pswpout 897557888`, above the 4,096 MiB threshold.

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
