# Network observations v1 implementation plan

Implement the revised v1 reception history, device installation revisions and
network maps in both account GUIs. Account projects, offline browser projects,
planner extraction and simulation comparison remain later specification phases.

Work is isolated on paired `feat/network-observations-v1` branches. Edge base is
`492935d3e`; cloud was advanced to `a84582c6` during integration. Cloud implementation
commit `92e94906` is deployed on the test server; edge implementation is `4b7ec8ceb`.
The user authorized Luna workers, orchestrator review, fixes and test deployment.
Workers do not deploy. The original dirty edge checkout remains separate.

## Invariants

- Keep radio metadata in a bounded dedicated database. Capture defaults off.
- Extend history sync v1 with `radio_uplinks`; retain its row-level quarantine,
  cursor, dirty correction and ACK semantics. No second radio transport.
- Keep gateway GPS and Terra anchor authorities unchanged.
- Store device revisions in the operational database and use its existing
  events and pending-command paths. Validate current installation and access.
- Mirror maintained Pi payloads byte-for-byte. Ordered migrations only.
- Show recorded points and receiver links without inferring area coverage or
  packet delivery ratio. Antenna gain accepts 0 through 13 dBi.
- Support all seven host locales and worldwide topographic tiles.

## Phases and ownership

| Phase | Parallel work | Status |
| --- | --- | --- |
| 0: baseline and contracts | Parent readiness review | Complete; contract and readiness documents present |
| 1A: radio normalization/storage | Luna edge worker | Implemented and reviewed; restart, storage and identity tests pass |
| 1B: cloud radio history | Luna cloud worker, parallel with 1A | Implemented; shared hash fixture and PostgreSQL replay/quarantine tests pass |
| 2: capture/history integration | Parent, after 1A/1B interfaces agreed | Implemented; correction generation/ACK tests and full edge verifier pass |
| 3: installation revisions | Edge/cloud workers; parent owns shared flows/contracts | Implemented; transactional command/event/ACK and current-installation tests pass |
| 4: account network views | Edge/cloud GUI workers in parallel | Implemented; tests and production builds pass; browser check remains open |
| 5: integration and test pilot | Parent review, independent Luna access review | Cloud acceptance deployed; database upgrade and rollback rehearsed; edge pilot pending |

Parent review corrected generation races, malformed metadata handling, cloud
ownership predicates, device transfer/history isolation, admin mutation scope,
legacy owner reads, missing translations, position precedence and page routing.
The independent access review’s four findings were fixed and rechecked.

## Current verification

Detailed evidence and limitations are in
`2026-09-10-network-observations-execution.md`.

- Edge integration suite: 40 tests, zero skipped. Full sync verifier, helper
  registration, profile parity and communication contract pass.
- Cloud selected backend checks after rebase: 41 tests, zero skipped, including
  Flyway lineage and revision applier tests.
- Cloud frontend: 81 script tests and 803 component tests pass. Edge network
  page: 5 tests pass. Both production builds pass.
- Complete boot JAR passes the Terra release-token and packaged-asset checks.
- Restored test-server database: thirteen foundation migrations applied, twelve
  Terra version labels reconciled, then three network migrations applied.
  Flyway validates all 101 migrations; no row-count loss across the 77 original
  tables. Previous backend startup and subsequent roll-forward also pass.

## Deployment and remaining execution

The cloud acceptance layer is deployed at
`https://server.opensmartirrigation.org/network` with image
`network-92e94906`. Health, page assets, seven locales, login, authenticated
metrics and WebSocket origin checks passed. The smoke account owns no gateway;
its observations request correctly returns 403. No gateway advertises the new
installation capability yet. The edge was not deployed.

1. Complete browser checks when the browser runtime is available. Its native
   connection failed before initialization, including after the IDE restart.
2. Obtain the designated edge gateway alias/EUI and its linked pilot account.
   Run the provisioned migration/restart pilot with backups.
3. Verify authorized network reads and an edge/cloud radio roundtrip. Then
   enable capture only on that gateway and inspect device revision ACKs.

The complete test-server backup, migration evidence, image hash and rollback
procedure are recorded in the execution report and the cloud deployment record.
The network migration versions are `2026.09.17.001` through `.003`; they must
still sort after main at merge time.
