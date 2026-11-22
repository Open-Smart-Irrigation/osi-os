# EB2 implementation evidence

The edge now accepts an authorized relink reply without inheriting the previous
cloud account ID. It retains the nonce, baseline, server and installation checks.
Account requests carry their own credential snapshot. A local SQLite transaction
and private MQTT configuration journal coordinate finalization and disconnect;
a retry restores or completes an interrupted operation before sending another
link request. No schema change was needed.

The implementation lives in the existing installation helper, which already ships
through image and script deployment. Both profiles carry identical payloads.
The flow-size ratchet permits the change without an exception: embedded JavaScript
falls by 44,267 characters per profile. Six empty flow catches were removed or
made visible; the maintained baseline falls from 65 to 59.

## Baseline and scope

Startup initially reported MISMATCH at f1073d151: 79 behind and 3 ahead of
origin/main, with older instructions. The unrelated GUI commits remain on their
original branch. As required by the implementer brief, this dedicated worktree
started a new branch from origin/main ec822b556. A fresh readiness run reported
READY, behind 0/ahead 0, with AGENTS.md matching the base at revision c63103827.

Cloud source was fetched and read from origin/main b002b807b using `git show`.
The cloud checkout was not edited. Its current ownership gate refuses an already
claimed foreign gateway before MQTT provisioning. This patch preserves that
policy; it does not grant an account transfer.

No GUI, deployment pins, schema, seed images, identity daemon, boot-DDL node or
migration preflight changed. Restart requests remain daemon-owned. The identity
sentinel is checked before linking and again before accepting/finalizing a reply.

## Regression evidence

The initial #667 test failed on both profiles with `stale_peer_context`, naming
the old account ID in the captured context. It now passes after a simulated lost
remote reply and two successive authenticated relink submissions.

A second run loaded the original flow and helper sources from ec822b556 without
switching the checkout. All seven selected regression probes failed as expected:
two relink probes, two disconnect rollback probes, two request-snapshot probes,
and the late token-refresh probe. The focused account-link suite passed 32/32 before the final binding/probe
corrections. Those corrections still need the final verification run.
It also covers partial UCI failure, restoration failure, recovery on either side
of SQLite commit, restart-publication failure, abandoned durable attempts,
preflight refusal and a sentinel appearing during authentication.

The first full verifier run exposed a missing `osiLib` binding on the extracted
disconnect node. That binding is now declared. The account-link harness now
injects only declared node libraries, so that runtime mistake cannot be masked by
its test sandbox. The scoped-access probe has recording-only journal/UCI support;
its denied-request rules and exemption lists remain unchanged.

## Checks

SQLite suites and the full sync verifier run serially under:

```text
osi-heavy wait --contain --scratch-tmpfs 1G --need-gib 8 -- <command>
```

| Command | Result |
|---|---|
| `node --test scripts/test-account-link-legacy-cloud.js` | PASS, 32 tests |
| `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.test.js` | PASS, 30 tests |
| `node scripts/test-installation-helper.js` | PASS |
| `node scripts/test-sync-token-refresh-window.js` | PASS, 4 tests |
| `node scripts/test-flows-wiring.js` | PASS |
| `node --test scripts/test-sync-history-queue-drain.js scripts/test-sync-history-manifest-paging.js` | PASS, 54 tests |
| `node scripts/verify-sync-flow.js` | First run FAIL; binding corrected; final rerun BLOCKED by the shared heavy slot |
| `node scripts/verify-profile-parity.js` | PASS |
| `node scripts/verify-no-new-silent-catch.js` | PASS, 59 per maintained profile |
| `node scripts/verify-no-stray-ddl.js` | PASS |
| `node scripts/verify-flows-size-ratchet.js` | PASS |
| `node scripts/flows-bare-require-scan.js` | PASS |
| `node scripts/verify-flows-fn-parse.js` | PASS |
| `node scripts/verify-helper-registration.js` | PASS |
| `node scripts/verify-live-gateway-identity.js` | PASS |
| `node scripts/verify-auth-flag-off-hermetic.js` | PASS |
| `node scripts/verify-sync-contract.js` | PASS |
| `node scripts/test-contract-schemas.js` | PASS |
| `node scripts/verify-sync-op-parity.js <cloud-snapshot>/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java` | PASS, 44 server operations |
| `node scripts/verify-communication-contract.js` | PASS |
| `scripts/check-mqtt-topics.sh` | PASS |
| `node scripts/verify-doc-hygiene.js` | PASS, built-in patterns; private name list unavailable |
| `node scripts/verify-agents-size.js` | PASS |
| `node .claude/skills/anti-slop-writing/slop-check.js <changed Markdown files>` | PASS |
| `git diff --cached --check` | PASS |

The operation-parity script's default sibling-path discovery failed in this T3
worktree. Its explicit-source run passed against cloud origin/main files copied
with `git show`. The first replication test invocation lacked scripts' pinned
AJV dependencies; `npm ci --prefix scripts --ignore-scripts` installed them and
the suite then passed. Neither failure required a runtime or cloud change.

No GUI gates apply. No live gateway or backend service was contacted.

CI on the first draft also found stale URL sandbox exceptions for the extracted
account-link handler and MQTT staging node. Both obsolete entries were removed.
`node --test scripts/verify-flows-sandbox.test.js` then passed 9/9, and
`node scripts/verify-flows-sandbox.js` passed for all repository profiles.

## Verification blocker

The first umbrella run failed in the scoped-access probe because `al-unlink-db`
did not declare `osiLib`. The binding is fixed. Its new persistence path also
needs the recording-only UCI/journal fixture now included in the probe.

The final rerun could not start: another job held the shared heavy slot while
waiting on storage I/O. After an extended queue wait, the implementer cancelled
its own queued checks to hand off a reviewable draft without leaving a waiting
process behind. No other job was changed. The final declared-library harness,
identity-guard refinement and probe corrections need a fresh run; the earlier
focused passes do not stand in for that result. CI and the assigned reviewer
must clear the full verifier before this draft is considered ready.

## Deferred and cross-repo work

- The K1 authority contract was absent at the base. K1 must decide
  owner/member handover, account-transfer authorization and the
  effect of disconnect on other local linked users. This patch retains the
  existing authenticated-user scope and local-only disconnect behavior.
- B9 owns the GUI. EB3 owns durable sync-failure reporting and actionable health.
- Cloud registration currently creates the account before completing local-sync.
  Replaying an uncertain `action=register` needs a cloud registration/operation
  receipt contract; this patch does not silently turn registration into login.
- Cloud local-sync commits a gateway claim before MQTT provisioning and subsequent
  installation/link recording. A cloud-wide atomicity or provisioning receipt
  change belongs in osi-server, after K1. The edge retry fix accepts a complete,
  authorized response without rejecting its new account ID.
- Remote unlink/revocation needs a paired API and account policy. No such cloud
  mutation was added here.

The PR stays draft. The dispatcher-assigned Sol review, independent verification
and paired deployment qualification remain pending. No review was requested and
no merge was attempted by this implementation sub-agent.


## P1 re-review correction

The first Sol review at ad92d6fbc required a durable restart obligation after
normal finalization. SQLite/UCI could be committed and the journal removed before
the later request-file write failed. That could leave MQTT using its prior
boot-time credentials with no recoverable restart obligation.

Normal commit now flushes SQLite/WAL, stamps `restart_pending` and retains the
journal. The restart nodes are thin module delegates: the module validates the
receipt against the committed account, publishes the existing three-field
identityd request atomically, then removes the receipt. A publication failure
leaves the receipt and returns an applied-but-restart-pending 503. Recovery on
startup and before either account operation follows the same rule.

A retry matching the committed link's original target returns the saved reply
through the builder's third output, wired to local success. It makes no new
cloud authentication request. A disconnect retry does not repeat its writes.
A different requested operation first publishes the prior obligation, then asks
the caller to retry after the scheduled restart. No account ownership rule was
added. Cloud MQTT publications now pass through thin guards using the same
receipt/sentinel predicate, so unresolved recovery pauses both MQTT and REST.
MQTT input/output nodes and broker configuration remain unchanged.

Before editing, the branch was clean at ad92d6fbc. Readiness reported WARN,
behind 1/ahead 2 from origin/main 1a984f31f. The intervening main commit only
updated failed-restore guidance. Rebase completed without conflicts; range-diff
showed both existing commits unchanged. Readiness then reported READY at
9e3f9e6f7, behind 0/ahead 2, AGENTS.md revision c63103827.

The focused restart-obligation tests load the original helper and flows from
ad92d6fbc for the red run. They cover directory, write and rename failures after
commit for both operations and profiles; retries without cloud authentication;
commit/publication interruption; startup failure and retry; recovery before a
different operation; interruption before the committed stamp; original versus
canonical login spelling; and cloud MQTT guards. The MQTT configuration hash is
pinned from the reviewed head so ordinary CI needs no historical checkout.

The updated implementer brief makes GitHub CI on the exact pushed SHA the full
suite gate while the second workstation is unavailable. Full suites were not
queued locally for this iteration. Local focused tests use the required
`osi-heavy wait --contain --scratch-tmpfs 1G --need-gib 8 --` wrapper. Current
results and the exact-head CI snapshot are reported with the corrective push;
the Sol re-review remains pending.


P1 local results:

| Check | Result |
|---|---|
| Restart-obligation regressions against ad92d6fbc | Expected RED: 32 failures |
| Restart-obligation regressions on the correction | PASS: 32 tests |
| Existing account-link suite | PASS: 32 tests |
| Flow wiring suite | PASS |
| Profile parity, identity verifier, size/catch/DDL/require/parse/sandbox guards | PASS |
| Helper registration, test inventory, instruction and documentation hygiene | PASS |
| Frozen boot node and migration-preflight bodies | Unchanged; identity verifier PASS |
| Full suites | Exact-head GitHub CI is the gate; see the corrective-push report |

One exploratory run of older Terra/scoped migration CLIs still refused unrelated
command-node shapes already present on the reviewed head. Their speculative edits
were discarded. The journal-command generator's approved shape comparison now
recognizes only the added cloud ACK guard, and its current-flow idempotence probe
passes. No SQL or schema checksum was changed.

## Round-2 daemon handoff correction

Sol's second review closed the publication-failure P1 and found a later gap at
7d2ff7c72: after publication removed the journal, a queued account request did
not block transport or another account operation. The reviewer's local probe
reproduced this for both link and disconnect, before identityd wrote its sentinel.

The shared helper now reads the journal, queued account requests and identity
sentinel in that order. Publication precedes journal removal; identityd publishes
the sentinel before deleting a request. Each handoff therefore retains a blocker.
Missing queue directories are empty; other queue-read failures block. Temporary
files and bootstrap requests are excluded. New account work checks this fence
after recovery and before remote authentication preparation or local mutation.
Recovery can still publish a pending journal and return its saved reply.

Both module copies are identical. This correction makes no flows.json edit:
both files retain SHA-256
`3452f2a9b61c348b9869ec284e7a3f7ac07985a0a84bd73211af1668a02e4f10`.
The publisher, identityd request contract and delays remain unchanged, as do the
frozen boot and migration-preflight bodies. No cloud or account-policy change.

Readiness initially reported WARN at 7d2ff7c72, behind 14/ahead 3 from main
bda200db6. Rebase completed cleanly. Range-diff showed all three prior commits
unchanged; the rebased parent helper matches the reviewed helper byte-for-byte.
Readiness then reported READY at 3e06414b8, behind 0/ahead 3, with AGENTS.md
revision c63103827f. Main's startup-flow recovery changes remain intact.

The restart-obligation suite now defines 52 cases. Its 20 new cases cover both
operations and profiles, normal and recovery publication with identityd paused,
all six MQTT guards, subsequent link/disconnect refusal, sentinel takeover,
queue-read faults and handoff read order. The SQLite account-link suite adds four
cases for the same committed-state handoff, for 36 total. Existing fixtures now
represent an empty request queue or a completed daemon restart where needed.

Local behavioral execution did not start. The baseline command queued through
`osi-heavy wait --contain --scratch-tmpfs 1G --need-gib 8 --` behind a live
firmware build and another waiting firmware build. The implementer cancelled only
its own waiting wrapper before pushing. No new RED/GREEN or SQLite suite pass is
claimed for this correction. The preceding review's reproduction is independent
evidence of the defect; GitHub CI on the corrective head runs both test suites
and is the full-suite gate under the current brief.

| Local command | Result |
|---|---|
| `node scripts/verify-profile-parity.js` | PASS, all parity checks |
| `node scripts/verify-live-gateway-identity.js` | PASS, live identity verification |
| `node scripts/verify-flows-size-ratchet.js` | PASS, 3,085,262 characters vs main's 3,173,796 |
| `node scripts/verify-no-new-silent-catch.js` | PASS |
| `node scripts/verify-no-stray-ddl.js` | PASS |
| `node scripts/flows-bare-require-scan.js` | PASS |
| `node scripts/verify-flows-fn-parse.js` | PASS |
| `node scripts/verify-flows-sandbox.js` | PASS |
| `node scripts/verify-helper-registration.js` | PASS |
| `node scripts/verify-test-inventory.js` | PASS |
| `scripts/check-mqtt-topics.sh` | PASS |
| `node scripts/verify-doc-hygiene.js` | PASS |
| Anti-slop checker on changed prose | PASS |

The draft stays with the assigned Sol reviewer for re-review. K1 policy, B9 GUI
and the earlier cross-repo deferrals remain outside this correction.

## Round-3 CI correction

Round 3 (`27b8772d1`) found four required checks red: `actuation-text-caps`,
`schedule-timestamp-wire-format`, `verify-sync-flow` and `migrations`. Ten test
or generator files passed on main and failed on the head. This round changes
only tests, one test library and one generator pin. Both `flows.json` files and
both helper copies are byte-identical to `27b8772d1`; the R2-P1 fence is
untouched.

Main `51f56dc6f` was merged into the branch first (merge `459f883ce`). Main had
moved past the reviewed `382c63a91` by one image-only commit (#703), and the
merge was clean.

| File | Change |
|---|---|
| `scripts/test-release-1.0-surfaces.js` | Route Command's UC512 output is expected at the command-ACK account guard; a new assertion checks that guard forwards only to the original MQTT node. |
| `scripts/test-valve-actuation-text-caps.js`, `scripts/test-valve-schedule-timestamp-wire-format.js`, `scripts/test-command-ack-mark-delivered.js`, `scripts/test-outbox-event-flush.js` | The sandbox `osiLib` resolves `installation` to the real profile helper, so builders run the shipped `gatewayWorkBlocked`. |
| `scripts/test-entity-name-command-path.js`, `scripts/test-watermark-calibration-bootstrap.js`, `scripts/test-watermark-cloud-command-path.js` | The link request's 11-entry capability list is read from the helper's `accountLink_build`, after checking that `al-link-build-req` delegates to the `build` stage and that the request sends `syncCapabilities`. |
| `scripts/migrate-flows-journal-helper-loading.js` | Shape and node hashes map the guard id back to the unguarded ACK target before comparison. The journal-commands generator already does this. The generator reports `already current`. |
| `scripts/migrate-flows-journal-v2-replication.test.js` | Both sides move the six guards to the end in their existing order. The guards are still compared byte for byte; only their position differed. |
| `scripts/test-gateway-eui-attribution.js` | An eleventh stale test, found by a sweep for the same patterns. It runs in `migrations.yml` after `verify-sync-flow.js`, so CI never reached it. It passes on main 9/9 and failed on the head 3/9 (`stale_link_attempt`). The harness now runs the real `al-link-build-req` before finalization. That claims the account operation, begins the attempt and carries the per-request state. Both stages share one in-memory gateway for the journal and UCI writes. The source check reads `accountLink_finalize` and `accountConfigTransaction`. |

The shared helpers live in `scripts/lib/installation-osi-lib.js`: the `osiLib`
binding, `accountStageSource`, `linkBuilderSource` and `accountGatewayIo`. A
fresh in-memory gateway per link attempt stands for the daemon-owned restart
completing between attempts. The restart-obligation suite covers the paused
daemon.

Red runs on an extracted copy, reverted afterwards:

- Dropping `watermark_v1` from the helper list fails all three capability tests
  (entity-name 18/19, calibration-bootstrap 0/1, cloud-command 0/1).
- Rewiring the guard to `command-ack-queue-rest` fails the release-surface test
  11/13.
- `test-gateway-eui-attribution.js` on `27b8772d1` gives 3/9.

Once those landed, CI got past `verify-sync-flow.js` and exposed four more
files with the same causes. Each passes on main.

| File | Cause and change |
|---|---|
| `scripts/test-installation-recovery-flow.js` | Read the build, handle and finalize nodes for content; it now reads those stages in the helper. |
| `scripts/test-radio-history-flow-integration.js` | The history builder's account check had no `global`; the harness now gives it a clean gateway `fs`. |
| `scripts/test-valve-command-safety-path.js` | The ACK landed at the guard, not at `Command ACK → Cloud`. The harness now runs the guard with the real helper, and asserts the guard forwards only to that node. |
| `scripts/test-issue-233-weather-detach.js` | The traversal expected the ACK MQTT node directly, and the disconnect case had no gateway IO. 89/89 now. |

The issue-233 suite only looked hung locally. SQLite fsync on this host's btrfs
scratch disk blocks in writeback. On tmpfs (`TMPDIR=/dev/shm/...`) it runs in
25 s, so the local timeout the round-3 review reported is environmental.
`test-protected-config-command-dispatch.js` fails under `node --test` here on
main as well. The plain `node` form that CI runs passes.

### Local gates and round time

- Before the first push: both valve wire checks passed (60/60, 32/32), as did
  `node scripts/verify-sync-flow.js` (1,081 s) and every touched test.
- After the first push: the rest of `verify-sync-flow.yml` ran in the local
  runner; `migrations.yml` after issue-233 ran on tmpfs, 27 of 27 steps green.
- Round time: authoring and local gates 12:25 to 13:37 UTC, including three
  pushes. The CI wait is recorded in the PR thread.
- Deviation from the brief: the first push went out before the full local
  suite finished. `verify-sync-flow.js` had passed and the remaining steps
  needed over an hour locally, so GitHub CI ran alongside the local runner.

### Assumptions to confirm

- The helper-loading pin normalizes the guard id instead of re-pinning hashes,
  as in the journal-commands generator. Re-pinning would break the pinned
  prior-current and direct-helper upgrade paths.
- In the v2-replication proof, the guards move instead of being dropped, so
  every node is still compared.

## Round-4 generator correction

Sol's round 4 (`66958080a`) found one P2. The helper-loading generator mapped
both the guarded ACK wire and a direct wire to the MQTT node onto the same
hash input. A flow that kept the guard node, but rewired
`command-dedupe-dispatch` or `command-ack-queue-rest` straight to MQTT, was
accepted as current.

The generator now checks for the guard node. When it is present, a guard wire
compares as the pinned target, and a direct wire to the MQTT node compares as
a bypass, so the hash fails. Without the guard node, which means a pre-EB2
flow, wires compare exactly as pinned. The before/after invariant uses an
exact shape digest with no wire mapping. Both `flows.json` files are
unchanged.

The generator suite adds 11 cases, for 120 in total. The 9 bypass cases cover
each owned node alone and both together, in the current, prior-current and
direct-helper states, and all are rejected. One case checks that a pre-EB2 flow
is a no-op when current and upgrades from both older states. One rejects a
guard id on the ACK wire when the guard node is missing. Against the round-3
generator, 10 of these fail; the pre-EB2 case passes on both.
