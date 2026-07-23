# AgroLink edge/cloud parity execution report

## Preparation record: 2026-07-23

**State:** Orchestrator inputs integrated into `design-sync/agrolink`;
autonomous implementation has not started.

### Repository bases

| Repository | Branch/worktree | Base |
|---|---|---|
| OSI OS integration | `design-sync/agrolink` in `.worktrees/agrolink-parity-orchestrator-prep` | Handoff content `5fc265bb` |
| OSI OS preparation source | `docs/agrolink-parity-orchestrator-prep` | `5fc265bb` |
| OSI OS `origin/main` | audited merge base | `b31825becbb8abcef86cfad9dc756cd2e351f135` |
| OSI Server | `AgroLink` in `.worktrees/agrolink` | `bee9435cf17b14ce582db61cc4bc9f1215657b8b` |
| OSI Server `origin/main` | branch source and merge base | `8cac33d3a8a210784fa5f9b73c8e4dfe796203f7` |

The edge target was zero commits behind `origin/main` at audit time. The
network planning work released its files on 2026-07-23; Task 0 must still
re-fetch and recheck the launch head.

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
- The launch parity matrix is deliberately a seed. Task 0 must generate the
  exhaustive route and contract inventory from code.

### Verification evidence

| Command | Result |
|---|---|
| `node scripts/verify-sync-contract.js` | PASS |
| `node scripts/test-contract-schemas.js` | PASS |
| `node scripts/verify-sync-op-parity.js` | PASS |
| OSI Server Testcontainers dependency insight | PASS: `org.testcontainers:testcontainers:1.21.4` selected |
| `./gradlew test --tests org.osi.server.testsupport.FlywayMigrationIT --no-daemon --max-workers=2` | PASS: PostgreSQL 16 container started; 17 seconds |
| `./gradlew test --no-daemon` | PASS: complete OSI Server backend suite, 1 minute 9 seconds |
| `free -m` before handoff revision | 23,379 MiB total; 12,048 MiB available |

The first server attempt failed before application assertions because Spring
Boot selected Testcontainers `1.20.5`, whose Docker client offered API `1.32`
to Docker Engine `29.6.1`, which requires at least `1.40`. Adding a second BOM
did not override Spring dependency management. Setting
`testcontainers.version=1.21.4` through the Spring-managed Gradle property
changed the resolved dependency and cleared the real integration test.

### Program ownership

The network planning program is finished. Its final local commit is `8f73306f`
and contains the reviewed design and Phase 1 plan. A search of all refs found no
network-drive schema, helper, flow, or implementation commit. Those future
files remain outside the parity program.

The old target worktree `/home/phil/Repos/osi-os-agrolink` still contains
unrelated generated GUI assets and locale changes. It is detached at
`f5ca4a1f` and quarantined rather than cleaned or staged. The executor must
work from the clean integration worktree and must not absorb those files.

### Remaining launch actions

1. Start the orchestrator prompt. It must run launch prerequisites and Task 0
   before implementing numbered tasks.

No production host, live gateway, external key provider, or AgroLink SMB share
was accessed.
