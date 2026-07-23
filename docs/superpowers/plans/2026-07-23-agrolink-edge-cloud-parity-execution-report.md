# AgroLink edge/cloud parity execution report

## Preparation record: 2026-07-23

**State:** Orchestrator inputs prepared and published; autonomous
implementation has not started.

### Repository bases

| Repository | Branch/worktree | Base |
|---|---|---|
| OSI OS | `docs/agrolink-parity-orchestrator-prep` in `.worktrees/agrolink-parity-orchestrator-prep` | `f5ca4a1fc4d3dc591c1e320a1f905cdb41bebc74` |
| OSI OS target | `design-sync/agrolink` | `f5ca4a1fc4d3dc591c1e320a1f905cdb41bebc74` |
| OSI OS `origin/main` | audited merge base | `b31825becbb8abcef86cfad9dc756cd2e351f135` |
| OSI Server | `AgroLink` in `.worktrees/agrolink` | `bee9435cf17b14ce582db61cc4bc9f1215657b8b` |
| OSI Server `origin/main` | branch source and merge base | `8cac33d3a8a210784fa5f9b73c8e4dfe796203f7` |

The edge target was zero commits behind `origin/main` at audit time. Recheck
after the active network program releases the branch.

### Inputs consolidated

- The orchestrator program incorporates the current code audit, reuse map,
  resolved product decisions, external review findings, stop conditions, and
  launch gates.
- Phase A uses accepted source commits `101d1f2f` and `2f7aa171` as semantic
  patch material. Its original migration numbers conflict with target
  migrations through `0032`; an integration overlay prevents direct replay.
- The newer reviewed Phase B-D documents are included.
- Phase E is retained as historical input and marked superseded because cloud
  access administration is now required through edge-approved commands.
- The launch parity matrix is deliberately a seed. Task 0 must generate the
  exhaustive route and contract inventory from code.

### Verification evidence

| Command | Result |
|---|---|
| `node scripts/verify-sync-contract.js` | PASS |
| `node scripts/test-contract-schemas.js` | PASS |
| `node scripts/verify-sync-op-parity.js` | PASS |
| OSI Server Testcontainers dependency insight | PASS: `org.testcontainers:testcontainers:1.21.4` selected |
| `./gradlew test --tests org.osi.server.testsupport.FlywayMigrationIT --no-daemon` | PASS: PostgreSQL 16 container started and Flyway test completed |
| `./gradlew test --no-daemon` | PASS: complete OSI Server backend suite, 1 minute 9 seconds |

The first server attempt failed before application assertions because Spring
Boot selected Testcontainers `1.20.5`, whose Docker client offered API `1.32`
to Docker Engine `29.6.1`, which requires at least `1.40`. Adding a second BOM
did not override Spring dependency management. Setting
`testcontainers.version=1.21.4` through the Spring-managed Gradle property
changed the resolved dependency and cleared the real integration test.

### Active-program ownership

The shared target worktree `/home/phil/Repos/osi-os-agrolink` belongs to the
ongoing AgroLink network integration and was not edited by this preparation.
At audit it contains generated GUI assets, locale changes, and an office lock
file. Treat all of them as externally owned. Before Task 0, the network owner
must either commit and release the branch or provide an explicit file-level
handoff.

The parity executor must not touch network-drive specs, plans, schema, helpers,
flows, or imported external readings while that program is active.

### Remaining launch actions

1. After the network work releases `design-sync/agrolink`, integrate the head
   of `docs/agrolink-parity-orchestrator-prep` into that branch without taking
   its dirty generated files. Preparation content commit:
   `0b41e60e0e24b7c6c7735c88c9e4b5a659b0e866`.
2. Start the orchestrator prompt. It must run launch prerequisites and Task 0
   before dispatching implementation slices.

No production host, live gateway, external key provider, or AgroLink SMB share
was accessed.
