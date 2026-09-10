# Network observations execution checkpoint

The cloud acceptance layer is deployed on the test server at
`https://server.opensmartirrigation.org/network`. Edge deployment and the
radio roundtrip remain pending a designated gateway and linked pilot account.
No production host was accessed.

## Implemented and reviewed

Edge commit `4b7ec8ceb` provides bounded radio storage, history v1 transport,
installation revisions and the account network view. Cloud commit `92e94906`
provides the mirror, capability-gated revision commands and account network view.
Both interfaces use worldwide topographic tiles and all seven host locales.
Antenna gain accepts 0 through 13 dBi.

Parent and Luna reviews corrected receiver-generation races, gateway ownership
checks, transferred-device history exposure, admin mutation scope, legacy owner
reads, location precedence and pagination windows. The final integration review
also found that revision command records lacked the effect key sent in their
payload. The issuer now persists that same key, matching the edge ACK contract;
a regression test verifies the binding.

Cloud main advanced during rollout preparation. The branch was rebased onto
`a84582c6`, and its three unshipped migrations moved to `2026.09.17.001–003`
after main's new pending-projections migration. The ordering gate passes.

## Verification

- Edge radio/revision/API suite: 40 passed, zero skipped. Full sync verifier,
  seed replay, bundled schema consistency, profile parity and contract checks
  passed during implementation.
- Edge network page: 5 tests passed; production build passed.
- Cloud selected backend checks after rebase: 37 passed, including Flyway
  lineage, plus 4 revision mirror applier tests. No failures or skips.
- Cloud frontend: 81 script tests and 803 component tests passed.
- Complete boot JAR passed frontend/Terra build and packaged-asset checks.
- Fresh target-dump rehearsal: 13 foundation migrations applied under the old
  Terra lineage, 12 byte-identical Terra labels reconciled, then 3 network
  migrations applied. Flyway validates 101 migrations. No row-count loss across
  the 77 original tables.
- The exact previous backend started after the rehearsed label reversal.
  Roll-forward applied no further DDL and preserved counts across 109 tables.

The browser runtime still fails before initialization. No browser smoke pass
is claimed; component and HTTP checks do not replace that evidence.

## Test deployment

The backend now uses `network-92e94906`. Only the backend was recreated. Compose
retains that image pin and supplies the test HTTPS origin explicitly, as required
by the new WebSocket configuration. Other services were not recreated.

The full backup is
`/home/rocky/backups/osi-server-network-20260910T213627Z`. It includes the repo,
configuration, PostgreSQL dump/globals, MongoDB logical dump, persisted service
files and exact previous JAR. Archive checks and SHA-256 verification passed.
A second PostgreSQL dump was taken with the backend stopped and no other
application database clients connected.

The first runner attempt stopped before a database connection because extracted
libraries were unreadable by the container's unprivileged user. The old backend
was restarted; Flyway still had 85 rows. Library permissions were corrected and
a read-only probe under the actual deployment user passed before the retry.
The retry applied the rehearsed stages, validated 101 migrations and preserved
all original table counts. The final target verifier also passed against the
actual deployed database.

Post-deploy checks passed: health, `/network`, its script asset, all seven locale
files, login and authenticated metrics. Unauthenticated observations/metrics
return 403. The smoke account has no gateway and scoped access is off; its
observations request correctly returns 403. Positive gateway-scoped reads remain
pending the pilot account. The configured WebSocket origin returns 200 at the
SockJS info route; a foreign origin returns 403. Zero linked gateways advertise
installation revision support, so the cloud cannot issue those commands yet.

The cloud record is `docs/operations/network-observations-test-deploy-2026-09-11.md`
in the paired server worktree. It records the artifact hash and rollback path.
Private dumps and rehearsal files remain outside both repositories under
`/home/phil/.cache/osi-network-rehearsal/`.

## Remaining scope

The edge migration/restart pilot, browser checks, authorized gateway reads and
radio roundtrip are still open. Capture stays off outside the designated pilot.
Account projects, offline browser projects and simulation comparison remain later
specification phases.

The original dirty edge checkout was not changed. Paired implementation worktrees
and recovery refs preserve the work across the IDE crash. The cloud recovery
stash `network-observations-before-main-869fc173` remains as an earlier copy.
