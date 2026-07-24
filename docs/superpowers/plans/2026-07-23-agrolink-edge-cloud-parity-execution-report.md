# AgroLink edge/cloud parity execution report

## Preparation record: 2026-07-23

**State:** Tasks 0 through 7 complete and pushed. Launch heads were fetched,
base gates run, one server frontend base defect repaired, the route/contract
inventory regenerated, the scoped-access governing documents reconciled, the
cross-repository contract gate and edge scoped-access foundation landed, and
the cloud desired-state ledger now reconciles command ACKs with edge mirrors.
The five journal event and command operations are enabled end to end, with
cloud mirrors, queued edits, exports, and a responsive journal workspace.
Scoped users and grants now follow the same edge-authoritative convergence
model, with per-installation cloud authorization and administration.

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

### Task 7 scoped cloud access

The server now stores gateway-local users, zone grants, and plot grants as
versioned mirrors. Five scoped event appliers enforce gateway identity,
monotonic versions, equal-version equality, tombstones, and desired-state
convergence. Server authorization resolves the selected linked installation
to its local `user_uuid`, role, and enabled state. Global cloud roles do not
grant farm access, and one cloud user may be an administrator on one gateway
and a viewer on another.

Cloud access changes use six versioned pending commands. They remain desired
state until the edge applies them. The edge helper validates gateway and
effect-key bindings, protects the last enabled administrator, applies the
resource mutation and terminal ACK in one transaction, and invalidates cached
scope after success. Conflicts and permanent rejections remain recoverable
terminal states rather than false success.

The `/gateway-access` cloud workspace switches among linked installations,
filters actions by the selected membership, lists mirrored users and grants,
and overlays pending changes. It supports user lifecycle, password reset, and
zone or plot grant changes, with distinct pending, conflicted, and rejected
feedback. Cloud grant enumeration comes from the canonical mirrors; the edge
administration page still shows only grants created during its current page
session because the local API has no grant-list route.

Contract activation removed all scoped commands and events from the staging
manifest. The operation scanner was corrected to walk the complete Java source
root, so appliers in the `scopedaccess` package cannot be missed. The server now
matches all 28 governed event operations. The `CONFLICT` ACK result is active
for desired-state recovery.

Task 7 verification:

| Command | Result |
|---|---|
| Scoped server mirror, applier, authorization, desired-state, and controller selections | exit 0 |
| `NODE_OPTIONS=--max-old-space-size=2048 ./gradlew test --no-daemon --max-workers=2` | exit 0; `BUILD SUCCESSFUL in 1m 10s` |
| Focused cloud access frontend selection | exit 0; 4 files and 17 tests passed |
| `npm run test:unit` | exit 0; 73 files and 288 tests passed |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run build` | exit 0 |
| Edge scope helper, command path, scoped write, scoped read, and endpoint ratchet suites | exit 0; 20, 5, 24, 23, and 6 tests passed |
| `node --test scripts/verify-sync-op-parity.test.js` | exit 0; 44 tests passed |
| `node scripts/test-contract-schemas.js` | exit 0 |
| `node scripts/verify-sync-contract.js` | exit 0 |
| `node scripts/verify-sync-op-parity.js` with the server source override | exit 0; all 28 event operations matched |
| `node scripts/verify-sync-flow.js` with the server source override | exit 0; umbrella sync and profile gates passed |
| Server vendor unit and byte-comparison scripts | exit 0; six files matched |
| `./gradlew test --tests org.osi.server.sync.SyncContractVendorTest --no-daemon --max-workers=2` | exit 0 |

Server commits `e8268566`, `89fd0ad0`, `7e4d013e`, `f07d0879`,
`c55375e7`, and `5ca86425` were pushed to `AgroLink`. Edge commits
`b4cb078c`, `0303e68e`, `95c6f5c8`, and `0f17892f` were pushed to
`design-sync/agrolink`. Remote branch lookups returned the exact local heads
after each push.

Task 7 heavyweight samples recorded between 11,552 MiB and 12,128 MiB
available during final contract verification. All samples cleared the
4,096 MiB threshold. No owned or unrelated process was terminated.

### Task 8a zone parity

Zone lifecycle and portable configuration now converge through one protected
aggregate. Edge migration `0035__zone_insert_outbox.sql` adds the missing
insert trigger, so a locally created zone emits one complete
`ZONE_UPSERTED` event after its identity fields exist. The protected edge
consumer validates the gateway, local owner UUID, effect key, command shape,
and exact base and target versions before changing SQLite. Create, update, and
delete apply atomically with the terminal command ledger result. Delete first
detaches assigned devices and then tombstones the zone.

The governed contract accepts `UPSERT_ZONE`, `UPSERT_ZONE_CONFIG`,
`UPSERT_ZONE_LOCATION`, and `DELETE_ZONE`. All non-delete edits share the
`zone:<zone_uuid>:<base_version>` effect family, allowing the server to
replace an unleased config command with one full-zone aggregate instead of
issuing deterministically conflicting config and location versions. Delete
uses its separate `zone_delete:` family. The edge advertises
`zone_desired_state_v1` from local link, bootstrap, and force-sync payloads
only after the protected consumer and contract passed.

OSI Server persists that capability per linked gateway and uses the selected
gateway's local user UUID for cloud-originated creates. Per-gateway scope
controls create, update, and delete authorization. A capable gateway receives
one durable desired-state command; older gateways keep the existing raw
config and location commands. ACK and canonical mirror observations settle an
operation as applied only when both agree. Exact-version drift reaches the
recoverable conflicted state.

The cloud create modal loads enabled linked gateways, selects the sole gateway
automatically, and requires a choice when several are available. No linked
gateway retains cloud-local creation. Pending creates remain in zone lists but
do not expose actions that require a canonical numeric ID. Configuration and
location now travel in one request. Missing SoilHive field capacity, wilting
point, saturation, conductivity, readily evaporable water, and curve number
render as `—`. The portable edge field remains `soil_type`; the detailed
hydraulic profile is cloud-derived.

The first focused frontend runs failed on the missing gateway selection,
pending-card, aggregate-update, and missing-data behavior. The first backend
run failed to compile after the request contract changed. Those failures
cleared after implementation. The full backend suite then exposed 102
ArchUnit frozen samples displaced by one additional dependency on the
already-frozen `zone -> command` edge. The 102 removed and 102 reported cycle
paths had the same SHA-256 and zero set differences. A reviewed refreeze
replaced exactly 102 lines with 102 lines; a normal architecture run preserved
the resulting file hash, and the full suite passed.

Task 8a verification:

| Command | Result |
|---|---|
| `node --test scripts/test-zone-insert-outbox.js scripts/test-zone-command-path.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js` | exit 0; 24 tests passed |
| `node scripts/test-contract-schemas.js` and `node scripts/verify-sync-contract.js` | exit 0; protected zone schemas, effects, and rollout metadata passed |
| `node scripts/verify-sync-flow.js` | exit 0; capability, flow, schema, and profile-parity gates passed |
| Zone flow migration run twice | exit 0; the second run was byte-identical |
| Server vendor mutation script and `SyncContractVendorTest` | exit 0; all six contract files were byte-identical |
| Focused server capability, mutation, controller, desired-state, scope, ACK, and convergence selections | exit 0 |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run test:unit` | exit 0; 45 TAP tests plus 75 Vitest files and 296 tests passed |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run build` | exit 0; production build passed with the existing chunk-size warning |
| `npx tsc --noEmit` | exit 0 |
| Locale JSON parsing and anti-slop checks | exit 0 |
| Normal `ArchitectureTest` after the reviewed sample replacement | exit 0; baseline SHA-256 remained `586e6ca967e4b7e525ecd6688d973df561fd897e27c911711bd3f94cd244b28a` |
| `NODE_OPTIONS=--max-old-space-size=2048 ./gradlew test --no-daemon --max-workers=2` | exit 0; 1,145 tests, zero failures or errors, `BUILD SUCCESSFUL in 1m 9s` |
| `git diff --check` in both repositories | exit 0 |

Edge commits `b7787c17`, `9016d220`, `568d7f52`, and `be66dad6`
and server commits `e860ed93`, `f141dfb3`, `4bac172d`, and
`f83ef56a1e5b04824850b8cddf353fde4946b001` were pushed to their target
branches. Remote branch lookups matched the exact local heads after every
push.

The architecture refreeze started with 11,789 MiB available. The final full
backend suite started with 12,025 MiB available. Both samples included
`pswpin`, `pswpout`, and the highest-RSS processes and cleared the 4,096 MiB
threshold. No process was terminated. No production host, live gateway,
external key provider, or AgroLink SMB share was accessed.

### Task 8b schedule and irrigation-calibration parity

Schedules and measured irrigation calibration now converge as separate
zone-keyed resources. Edge migrations add calibration sync metadata and an
initial backfill event without changing scheduler or valve behavior. Local
schedule and calibration writes emit canonical events. The protected command
helper validates the selected gateway, zone UUID, exact base and target
versions, canonical timestamps, finite values, and supported schedule fields
before applying either resource in the command-ledger transaction.

The effect families remain independent:
`schedule:<zone_uuid>:<base_sync_version>` and
`irrigation_calibration:<zone_uuid>:<base_sync_version>`. Desired schedule
payloads omit `last_triggered_at`. Desired calibration payloads omit the
edge-local valve EUI; a new edge calibration row stores `NULL` in that column
until local hardware configuration supplies it. Every protected SQL write
uses bound parameters.

OSI Server records
`irrigation_config_desired_state_v1` per linked gateway. Capable gateways
receive protected schedule and calibration commands; gateways without the
capability keep the existing schedule command path and receive no calibration
command. The server does not write either canonical edge mirror when it queues
desired state. ACK and returning event convergence settle the operation, while
base-version drift remains a recoverable conflict. Per-gateway zone scope
guards both mutations.

The cloud UI overlays pending schedule and calibration values immediately,
shows pending, conflict, and rejection state, and blocks unsupported mirrored
schedule metrics until the user chooses one of the seven governed values.
Irrigation flow calibration is edited separately from dendrometer
calibration. All seven maintained locales include the new label.

Contract activation moved
`ZONE_IRRIGATION_CALIBRATION_UPSERTED` and
`UPSERT_ZONE_IRRIGATION_CALIBRATION` out of the staging manifest only after
both consumers passed. The calibration command is verified as a separately
routed protected command rather than being added to the legacy command-type
registry. The two maintained flow profiles and helper copies compare
byte-for-byte.

Task 8b verification:

| Command | Result |
|---|---|
| `node --test scripts/rehearse-irrigation-calibration-sync.test.js` | exit 0; 2 tests passed |
| Command-ledger, irrigation helper, and protected path Node selections | exit 0; 25 tests passed |
| Flow wiring and scoped-write suites | exit 0; 25 scoped-write tests passed |
| Migration, seed replay, runtime schema, bundled DB, DDL, trigger, and profile gates | exit 0 |
| `node scripts/test-contract-schemas.js` and `node scripts/verify-sync-contract.js` | exit 0; 29 governed event operations and 47 accepted commands, including two separately routed commands |
| `node --test scripts/verify-sync-op-parity.test.js` with the server source override | exit 0; 44 tests passed |
| `node scripts/verify-sync-op-parity.js` with the server source override | exit 0; all 29 event operations matched |
| `node scripts/verify-sync-flow.js` with the server source override | exit 0; umbrella sync and profile gates passed |
| Server vendor unit, byte-comparison, and `SyncContractVendorTest` gates | exit 0; all six contract files matched |
| Focused server capability, mirror, protected mutation, controller, desired-state, authorization, ACK, convergence, conflict, replay, and legacy-fallback selections | exit 0 |
| Focused cloud irrigation frontend selection | exit 0; 17 tests passed |
| `npx tsc --noEmit` | exit 0 |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run test:unit` | exit 0; 45 TAP tests and 307 Vitest tests passed |
| `NODE_OPTIONS=--max-old-space-size=2048 npm run build` | exit 0; production build passed with the existing chunk-size warning |
| `NODE_OPTIONS=--max-old-space-size=2048 ./gradlew test --no-daemon --max-workers=2` | exit 0; 1,181 tests in 220 suites, zero failures, errors, or skips; `BUILD SUCCESSFUL in 1m 14s` |
| Full-diff invariant review and `git diff --check` in both repositories | exit 0 |

The vendor plan's example passed the schema directory to
`EDGE_CONTRACT_ROOT`, although the verifier appends that directory itself.
The run used the repository root after the literal example failed its
canonical-file precondition. The first operation-parity invocation also found
the unrelated sibling checkout because no server source override was set.
Repeating it with the integration worktree's `EdgeSyncService.java` passed.
Neither environment-selection failure changed product files.

Edge commits `64d72f90`, `7bac1443`, `bd2cf3a3`, and `e1d487dd` and server
commits `90b7553a`, `2cc46512`, `9e517872`, `93752df1`, and `1d32cfc8` were
pushed to their target branches. Remote branch lookups matched the exact local
heads after every push.

The final backend suite started with 11,554 MiB available and ended with
11,980 MiB available. Swap counters moved from `pswpin=742671693` and
`pswpout=915546860` to `pswpin=742988801` and `pswpout=916119623`. Every
heavyweight sample cleared the 4,096 MiB threshold. No process was terminated.
No production host, live gateway, external key provider, or AgroLink SMB share
was accessed.

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
