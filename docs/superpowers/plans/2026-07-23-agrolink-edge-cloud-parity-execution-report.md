# AgroLink edge/cloud parity execution report

## Preparation record: 2026-07-23

**State:** Task 0 complete through pre-commit verification. Launch heads were
fetched, base gates run, one server frontend base defect repaired and pushed,
and the route/contract inventory regenerated.

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

### Memory samples

Every heavyweight command started above the 4,096 MiB threshold. Recorded
`MemAvailable` values ranged from 12,942 MiB to 14,155 MiB. During the
one-minute backend suite, availability fell by 705 MiB between the first two
samples while `pswpout` rose, below the 1,024 MiB termination threshold. No
owned process was terminated.

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
- 23 event operations, 40 command types, and 18 non-primitive resource schema
  definitions;
- the two current sync capabilities and the missing acceptance-versus-enablement
  split owned by Task 2.

All orchestrator, cross-contract, and Phase A-E documents referenced by the
program are present in `git ls-tree -r --name-only HEAD`. Ordered edge
migrations end at `0032__journal_catalog_v10.sql`; Task 3 must allocate the
next two free versions after another fetch and ownership check.

No production host, live gateway, external key provider, or AgroLink SMB share
was accessed.
