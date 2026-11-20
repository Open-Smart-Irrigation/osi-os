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
falls by 41,480 characters per profile. Six empty flow catches were removed or
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
