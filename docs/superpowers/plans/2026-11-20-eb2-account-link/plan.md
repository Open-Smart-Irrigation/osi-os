# EB2 account-link consistency

Fix #667 without choosing account ownership rules. The edge accepts the account
returned by an authenticated, identity-matching response. The cloud continues to
authorize claims. Base: ec822b556; cloud source: b002b807b.

The implementer is the execution sub-agent. The dispatcher has assigned a Sol
reviewer after this draft; independent review and verification remain pending.

## Changes

1. Add a two-profile regression to `scripts/test-account-link-legacy-cloud.js`.
   Lose the first response after a simulated remote commit, retry as another
   account and repeat the successful link. Expect `stale_peer_context` before
   the fix. Capture the red run before runtime edits.
2. In `osi-irrigation-policy/replication.js`, distinguish an unknown target
   account from the old committed account. Keep the baseline, nonce, request,
   server, installation and gateway checks. Explicit target IDs stay exact.
3. Extract account-link persistence and request handling into the existing
   `osi-installation-helper/index.js`, which already ships on both delivery
   paths. Keep Node-RED functions as wiring and the existing identity-sentinel
   reader at the link request boundary. Store request credentials on `msg`.
4. Serialize link/disconnect attempts in the module. A new process can recover
   an abandoned durable attempt; an active request cannot be superseded. Fence
   late replies with the existing durable nonce. Disconnect uses one SQLite
   transaction for user, peer and dirty-history-key writes.
5. Coordinate MQTT configuration with that transaction through a private,
   fsynced local journal. On a failed transaction, restore the prior config.
   After interruption, compare the journal's desired user/peer state with the
   database and finish or undo the config before another operation. Retain the
   journal if restoration fails and refuse further remote mutation until it
   can be reconciled. Pass UCI values as arguments, without shell interpolation.
6. Fence token-refresh writes by the previously captured bearer so a late old
   response cannot replace relinked credentials on the same server. Pause
   bootstrap, outbox, command polling/ACK, history and refresh builders while
   account work or its recovery journal is pending.
7. Keep restart publication owned by identityd. Preserve request contracts and
   frozen nodes. Add cleanup on restart-publication failure. No gateway access.

## Verification

Use `TMPDIR=/home/phil/builds/osi-v082-fix-20261112/plan-0.9/tmp-EB2`.
Run focused account-link tests, replication tests and injected persistence
failures. Run heavy checks serially through `osi-heavy wait --contain
--scratch-tmpfs 1G --need-gib 8 --`: `node scripts/verify-sync-flow.js` and
SQLite-backed account/replication suites. Run flow parse, wiring, size, silent
catch, DDL, require, profile, helper-registration, live-identity, sync-contract,
communication, doc hygiene and whitespace gates. Commit both profile mirrors.

## Deferred

K1 decides owner/member transfer and multi-user disconnect policy. Preserve the
existing authenticated-user scope. B9 owns GUI states and copy. Cloud transfer,
registration replay after an uncertain response, remote credential revocation
and server-side operation receipts need separate cloud work. Do not edit the
cloud checkout, schema, boot DDL or migration preflight.

## P1 review correction

Normal finalization must retain the private journal through daemon request
publication. Record `restart_pending` only after flushing the committed database;
recovery of an older receipt still probes the database. The module publisher
uses the same three-field identityd request and removes the receipt only after
atomic publication. Publication errors leave transport blocked by the journal.

Move both restart nodes to thin module delegates. A matching link retry recovers
the saved response through a third builder output wired to local success, so it
makes no cloud authentication request. A disconnect retry also returns the saved
completion without repeating its writes. A different requested account operation
first publishes the earlier obligation and asks the caller to retry after the
scheduled restart. Preserve all identity sentinel and frozen-body guards.

`scripts/test-account-link-restart-obligation.js` exercises both real profile
publishers with directory, write and rename faults after coordinator commit. It
also reconstructs the helper after a commit/publication interruption and runs
startup recovery. The restart-obligation regressions fail on ad92d6fbc because the committed
receipt is gone. The same tests must pass after the correction.


Cloud MQTT output guards share the same receipt/sentinel predicate as REST and
history. They sit before the existing MQTT outputs, including the disabled
simulation output. MQTT nodes and broker configuration stay byte-identical to
the reviewed head; ChirpStack downlinks keep their routes. ACK wiring pins name
the new guard, and the journal-command generator preserves it on an idempotent
run. The heartbeat function and independent health-sampling path are unchanged.
