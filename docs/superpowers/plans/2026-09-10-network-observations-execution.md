# Network observations execution checkpoint

Implementation is in the paired `feat/network-observations-v1` worktrees. No test-server container, database, or gateway was changed. This is a
verification checkpoint, not a deployment approval or a completed phase 5.

## Implemented and reviewed

Radio metadata uses a dedicated bounded SQLite store and the existing history v1
stream. Receiver corrections retain generation checks across the two databases.
Device location/radio revisions use transactional edge events and pending cloud
commands. Both host GUIs contain authenticated network views with worldwide
topographic tiles. Antenna gain accepts values from 0 through 13 dBi.

Parent review fixed cross-gateway observation links, granted-zone cloud reads,
transferred-device history exposure, an admin write bypass, revision history
queries spanning installations, mobile-position precedence, missing edge locale
keys, and unstable pagination windows. New edge integration tests are registered
in the migrations CI workflow.

## Verification

- Edge radio, revision command, and API suite: 40 passed, zero skipped.
- Full edge sync verifier: exit 0; final helper registration, profile parity and
  communication-contract checks also passed.
- Seed replay, bundled database consistency, ordered migration checks, revision
  outbox retention and generation-safe history ACK tests passed during integration.
- Cloud selected backend tests, including real PostgreSQL and Flyway lineage:
  40 passed, zero skipped, after the access review; cloud baseline is `869fc173`.
  The separate Flyway lineage test also passed after that baseline update.
- Edge network page: 5 tests passed. Cloud network page: 2 tests passed, including
  a second-page request retaining the server’s time window.
- Full cloud frontend suite: 81 script tests and 686 component tests passed.
- Both production frontend builds passed; existing bundle-size warnings remain.
- Complete cloud boot JAR passed the Terra token, distribution and packaged-asset
  checks. Packaged health was UP; `/network` and `/locales/fr/network.json`
  returned 200, while unauthenticated observations returned 403. A missing
  Spring page-route mapping found during this check was fixed and tested.
- Prose checks and tracked diff whitespace checks passed.

The browser runtime failed before initialization with “privileged native pipe
bridge is not available; browser-client is not trusted”. No browser smoke test
has passed in this session. Component tests do not replace that evidence.

## Deployment preflight

The SSH alias `osi-test-server` resolves to `server.opensmartirrigation.org`.
Read-only inspection found backend image `sha-38ef8b5`. Production was not accessed.
Cloud main advanced during implementation. It now owns Terra migration versions
`2026.09.15.001` through `.012`; the new, never-applied network migrations were
moved to `2026.09.16.001` through `.003`. The ordering gate passes.

The target’s actual Flyway history still records the twelve Terra migrations as
`2026.07.29.001` through `.012`. The mandatory target check fails on those missing
local versions. A local CSV preview of the documented Terra version reconciliation
then reveals twelve unapplied foundation migrations from `2026.09.10.001` through
`2026.09.14.001` below the renamed applied maximum. Therefore, applying the version
renames alone is not a sufficient deployment procedure. No SQL was sent to mutate
the target.

The staged database rehearsal passed against an isolated restore of the actual
test-server dump. It preserved the target’s old Terra lineage while applying the twelve intervening
foundation migrations, then reconciled the twelve byte-identical Terra versions
and applied the three network migrations. Final Flyway validation covered all
100 migrations. Row counts did not decrease across the 77 pre-existing tables.
No out-of-order or ignore-migration override was used.

Rehearsal files are in `/home/phil/.cache/osi-network-rehearsal/`, outside both
repositories. The database dump is private and must never be committed. The
scratch Java runner hardcodes the isolated loopback database, so it is not a
live deployment script. `/tmp/network-target-rehearsal.log` records the result.

Packaged startup passed. The exact previous backend JAR was copied read-only from
the test server and its SHA-256 verified against the running container. After
reversing only the twelve Terra version labels in the isolated copy, the previous
backend started with health UP. Roll-forward then reapplied zero DDL migrations,
restored the twelve labels, validated all 100 migrations, and found no row-count
loss across the now 108 tables. No history rows were deleted for rollback.
Take the required complete server backup before any live execution of these
stages. The database-only dump used for this rehearsal is not that full backup.

## Remaining acceptance work

The independent access review’s four findings were fixed and rechecked: weather
device gateway boundaries, installation history isolation, cloud legacy owner
access, and current installation validation before commands. New cloud services
also reject a disabled cloud account before querying or queueing.

Browser checks and edge provisioned migration/restart rehearsals remain open.
The edge pilot still needs a designated test gateway. Radio capture stays off by
default. Account projects, offline browser projects and simulation comparison
remain later specification phases.

The IDE crash preserved the worktrees, completed test logs and local rehearsal
containers. A stray root-level Vitest cache from a wrong-directory invocation was
removed after verifying it contained only the generated test result file.

A recovery stash named `network-observations-before-main-869fc173` remains in the
cloud repository after its successful application; the CSS conflict was resolved
using main’s already-merged fix. It is retained as a pre-rebase recovery copy. The original dirty edge checkout was not modified.
