# Network observations v1 implementation plan

Implement the revised v1 reception history, device installation revisions and
network maps in both account GUIs. Account projects, offline browser projects,
planner extraction and simulation comparison remain later specification phases.

Work is isolated on paired `feat/network-observations-v1` branches. Edge base is
`855aee17f`; cloud was advanced to `a84582c6` during integration. Cloud implementation
`93c7380e` and edge implementation `9f010325e` are deployed to the test pilot.
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
| 5: integration and test pilot | Parent review, independent Luna access review | Edge/cloud deployed; radio roundtrip verified; rolling health gate and authenticated UI acceptance pending |

Parent review corrected generation races, malformed metadata handling, cloud
ownership predicates, device transfer/history isolation, admin mutation scope,
legacy owner reads, missing translations, position precedence and page routing.
The independent access review’s four findings were fixed and rechecked.

## Current verification

Detailed evidence and limitations are in
`2026-09-10-network-observations-execution.md`.

- Edge integration suite: 42 tests, zero skipped. Full sync verifier, helper
  registration, profile parity and communication contract pass.
- Cloud final focused backend checks: 118 tests, zero skipped. Earlier Flyway
  lineage and revision applier checks also passed.
- Cloud frontend: 81 script tests and 803 component tests pass. Edge network
  page: 5 tests pass. Both production builds pass.
- Complete boot JAR passes the Terra release-token and packaged-asset checks.
- Restored test-server database: thirteen foundation migrations applied, twelve
  Terra version labels reconciled, then three network migrations applied.
  Flyway validates all 101 migrations; no row-count loss across the 77 original
  tables. Previous backend startup and subsequent roll-forward also pass.

## Deployment and remaining execution

The cloud runs `network-93c7380e` at
`https://server.opensmartirrigation.org/network`. The designated edge pilot runs
`9f010325e`, with capture enabled only there. Installation registration and
MQTT work. Five retained uplinks match the cloud by payload and timestamp;
the radio quarantine is empty.

1. Confirm continued acceptance of new weather updates and rerun the normal
   canary when retained rejection history ages out of its 24-hour window.
   No canary pass is claimed; audit rows remain intact.
2. Verify signed-in pilot network reads and device revision command/ACK behavior.
3. Complete browser checks when its native runtime can initialize.

The complete test-server backup, migration evidence, image hash and rollback
procedure are recorded in the execution report and the cloud deployment record.
The network migration versions are `2026.09.17.001` through `.003`; they must
still sort after main at merge time.
