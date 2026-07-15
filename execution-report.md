# Live gateway identity execution report

Execution branch: `feat/live-gateway-identity`

Execution worktree: `/home/phil/Repos/osi-os/.worktrees/live-gateway-identity`

Reviewed base: `553920e115ab7a83c5c5c824cf6149c11c9e50d0` (`553920e1 fix(verify): drop invalid negative flow allowance`)

## Task 0 — base verification

The isolated worktree initially had no GUI dependencies. The first `npm run typecheck` exited 127 with `tsc: command not found`; this was an environment setup failure, not a repository assertion. `npm ci` exited 0, after which the complete GUI gate passed.

| Command | Result | Output evidence |
|---|---:|---|
| `git status --short --branch` | 0 | `## feat/live-gateway-identity` |
| `git rev-parse HEAD` | 0 | `553920e115ab7a83c5c5c824cf6149c11c9e50d0` |
| `git log -1 --oneline` | 0 | `553920e1 fix(verify): drop invalid negative flow allowance` |
| `node scripts/verify-sync-flow.js` | 0 | `Sync flow verification passed`; chained parity ended `All parity checks passed.` |
| `node scripts/verify-communication-contract.js` | 0 | `Communication contract verification passed` |
| `node scripts/verify-profile-parity.js` | 0 | `All parity checks passed.` |
| `node scripts/verify-flows-fn-parse.js` | 0 | `verify-flows-fn-parse: OK` |
| `node scripts/verify-no-new-silent-catch.js` | 0 | bcm2712 and bcm2709 each: 225 empty catches, baseline 225 |
| `node scripts/verify-flows-size-ratchet.js` | 0 | Size ratchet passed |
| `node scripts/flows-bare-require-scan.js` | 0 | Bare-require scan passed |
| `node scripts/test-flows-wiring.js` | 0 | Wiring guards passed |
| `node scripts/verify-no-stray-ddl.js` | 0 | Stray-DDL ratchet passed |
| `scripts/check-mqtt-topics.sh` | 0 | Maintained flow copies reported `OK` |
| `git diff --check` | 0 | No output |
| `npm ci` | 0 | 269 lockfile-defined packages installed |
| `npm run typecheck` | 0 | `tsc --noEmit` |
| `npm run test:unit` | 0 | TSX runner: 83 passed, 1 skipped; Vitest: 96 files and 550 tests passed |
| `npm run build` | 0 | Vite transformed 1,639 modules and completed production build |

Task 0 verdict: green. Implementation may proceed.

## Task 1 — shared gateway identity heal

RED was observed before the helper implementation. `sh scripts/test-gateway-identity-helper.sh` exited 1:

```text
scripts/test-gateway-identity-helper.sh: line 31: gateway_identity_heal: command not found
FAIL: successful heal returned nonzero
```

After adding `gateway_identity_heal`, the helper dispatch, and the Node-RED startup fallback, the required gates passed:

| Command | Result | Output evidence |
|---|---:|---|
| `sh scripts/test-gateway-identity-helper.sh` | 0 | `PASS: gateway identity heal ordering and state propagation` |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh` | 0 | No output |
| `sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` | 0 | No output |
| `node scripts/verify-communication-contract.js` | 0 | `Communication contract verification passed` |
| `node scripts/verify-profile-parity.js` | 0 | `OK: files/usr/libexec/osi-gateway-identity.sh`; `All parity checks passed.` |
| `git diff --check` | 0 | No output |

Task 1 self-review found no scope, ordering, fallback, or profile-parity defect. The test covers exact success order, fail-fast behavior at each step, authoritative state propagation into the production repair function, and the provisional no-write path.

### Quality review follow-up

The quality review found that `scripts/verify-sync-flow.js` still pinned the removed direct repair and persist calls in `node-red.init`. Before the verifier fix, a fresh `node scripts/verify-sync-flow.js` exited 1 with these failures:

```text
FAIL: node-red.init missing self-heals active concentratord gateway-id state during startup
FAIL: node-red.init missing persists canonical gateway identity metadata during startup
```

The verifier now requires the shared heal call, exact failure log and fallback, exact ordered helper body, `heal)` dispatch, and focused helper test. The focused test also executes the helper's real CLI dispatch through temporary command stubs, without host UCI access.

| Command | Result | Output evidence |
|---|---:|---|
| `sh scripts/test-gateway-identity-helper.sh` | 0 | `PASS: gateway identity heal ordering and state propagation` |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh` | 0 | No output |
| `sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` | 0 | No output |
| `node scripts/verify-communication-contract.js` | 0 | `Communication contract verification passed` |
| `node scripts/verify-sync-flow.js` | 0 | `Sync flow verification passed`; chained parity ended `All parity checks passed.` |
| `node scripts/verify-profile-parity.js` | 0 | `OK: files/usr/libexec/osi-gateway-identity.sh`; `All parity checks passed.` |
| `git diff --check` | 0 | No output |

## Task 2 — live gateway identity daemon

The focused test was created before either daemon copy existed. The first `sh scripts/test-osi-identityd.sh` run exited 1:

```text
FAIL: osi-identityd.sh is absent
```

The completed test drives the daemon through sourced functions and real temporary JSON files. Its helper, UCI, clock, and Node-RED service doubles are path stubs; the production daemon has no clock or command override variables. The 17 scenarios cover provisional cadence, same-EUI confidence promotion, EUI replacement, failed or invalid heals, exact UCI readback, retargeting, crash recovery from `healing`, restart success and retry, request ordering, and per-tick request consumption.

| Command | Result | Output evidence |
|---|---:|---|
| `sh scripts/test-osi-identityd.sh` | 0 | `PASS: osi-identityd state machine (17 scenarios)` |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| `diff conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| `sh scripts/test-gateway-identity-helper.sh` | 0 | `PASS: gateway identity heal ordering and state propagation` |
| `node scripts/verify-sync-flow.js` | 0 | `Sync flow verification passed`; chained parity ended `All parity checks passed.` |
| `node scripts/verify-profile-parity.js` | 0 | `All parity checks passed.` |
| `git diff --check` | 0 | No output |

The Task 2 self-review found one pre-gate defect: an early draft applied mode `0700` to the configured run directory, which would have changed the shared production `/var/run`. The corrected code changes permissions only on `osi-node-red-restart-requests`; `umask 077` and explicit temporary-file modes protect the JSON files.

The final review found no remaining Task 2 defect in the tested state-machine interleavings. Cache and sentinel writes use same-directory temporary files followed by `mv`; request values are fixed enums and bounded integers; helper values are normalized before JSON construction; no `eval` or user-derived command is executed. A malformed sentinel is retained without a restart. Registration, service wiring, deploy, bootstrap, flows, and GUI work remain outside this task, and `OSI_REGISTRATION_SCRIPT` is accepted but never invoked.

### Task 2 spec-review follow-up

The spec review found that the request consumer scanned unfinished publication files. After adding a temp-file interleaving regression, `sh scripts/test-osi-identityd.sh` exited 1:

```text
FAIL: request publication temp retained: missing /tmp/tmp.BjzHh0LwEN/fixture-18/run/osi-node-red-restart-requests/manual.json.tmp
```

Changing the consumer glob from `*` to `*.json` made that regression pass. The test leaves a partial `.json.tmp` file beside a valid final request, confirms the tick consumes only the final request, then finalizes the temp file and confirms the next tick consumes it.

The review also found a mismatch with Node-RED's three-field request shape. The first contract regression exited 1 because the loader discarded the minimal file:

```text
FAIL: minimal Node-RED request scheduled: missing /tmp/tmp.k2nQApeDHL/fixture-19/run/osi-identity-restart.json
```

After the loader accepted the minimal shape, the same test reached the CLI assertion and exited 1 again:

```text
FAIL: request-restart publication contract: expected '{"reason":"account_link","delaySeconds":5,"requestedAtEpoch":1000}', got '{"reason":"account_link","delaySeconds":5,"requestedAt":"1970-01-01T00:16:40Z","requestedAtEpoch":1000,"restartAt":"1970-01-01T00:16:45Z","restartAtEpoch":1005}'
```

The loader now requires only `reason`, `delaySeconds`, and `requestedAtEpoch`. It derives `requestedAt` with `date -u -d "@$requestedAtEpoch"` and calculates the restart epoch from the bounded delay. The CLI atomically publishes the same three-field shape to a unique final `.json` path through a `.json.tmp` file.

| Command | Result | Output evidence |
|---|---:|---|
| `sh scripts/test-osi-identityd.sh` | 0 | `PASS: osi-identityd state machine (17 scenarios)` |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| `diff conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| `sh scripts/test-gateway-identity-helper.sh` | 0 | `PASS: gateway identity heal ordering and state propagation` |
| `node scripts/verify-sync-flow.js` | 0 | `Sync flow verification passed`; chained parity ended `All parity checks passed.` |
| `node scripts/verify-profile-parity.js` | 0 | `All parity checks passed.` |
| `git diff --check` | 0 | No output |
| `node .claude/skills/anti-slop-writing/slop-check.js execution-report.md` | 0 | `slop-check: PASS (no tier-1 findings)` |

### Task 2 nullable JSON review follow-up

`openwrt/package/utils/jsonfilter/Makefile` pins OpenWrt `jsonpath.git` commit `594cfa86469c005972ba750614f5b3f1af84d0f6`. Inspection of that exact commit's `main.c` found two separate contracts: `export_value()` emits nothing for `json_type_null`, while `export_type()` maps that type to the line `null`. The `-t` option calls `export_type()`; an unmatched path makes `filter_json()` return false and the command exit 1.

The old test double printed `null` for `-e`, which hid the production defect. After changing the double to the pinned semantics and adding reload regressions, `sh scripts/test-osi-identityd.sh` exited 1:

```text
FAIL: daemon-generated nullable cache did not reload
```

The daemon now calls `jsonfilter -t` before reading a nullable value. Cache `linkGatewayDeviceEui` and sentinel `targetDeviceEui` accept only `null` or `string`; the three healing deadline fields require `null`. Missing fields and wrong types fail before the existing exact canonical raw-object comparison. The focused suite reloads these daemon-generated artifacts:

- a cache with `linkGatewayDeviceEui:null`;
- a healing sentinel with null restart fields;
- a generic pending sentinel with `targetDeviceEui:null`.

Separate regressions reject a missing cache field, a boolean cache field, and a boolean sentinel target.

Final verification for the nullable JSON fix:

| Command | Exit | Output evidence |
|---|---:|---|
| `sh scripts/test-osi-identityd.sh` | 0 | `PASS: osi-identityd state machine (17 scenarios)` |
| `sh -n` on each maintained daemon copy | 0 | No output |
| Direct `diff` of the two daemon copies | 0 | No output |
| `sh scripts/test-gateway-identity-helper.sh` | 0 | `PASS: gateway identity heal ordering and state propagation` |
| `node scripts/verify-profile-parity.js` | 0 | `OK: files/usr/libexec/osi-identityd.sh`; `All parity checks passed.` |
| `node scripts/verify-sync-flow.js` | 0 | `Sync flow verification passed`; chained parity ended `All parity checks passed.` |
| `git diff --check` | 0 | No output; intent-to-add entries include all new files. |
| `node .claude/skills/anti-slop-writing/slop-check.js execution-report.md` | 0 | `slop-check: PASS (no tier-1 findings)` |
| `test -z "$(git diff --cached --name-only)"` | 0 | No content staged |

### Task 2 quality-review follow-up

The quality review produced eight additional failing regressions before the daemon was hardened. Each row records the first failing assertion and the behavior that made the focused suite green.

| Review item | RED evidence from `sh scripts/test-osi-identityd.sh` | GREEN behavior |
|---|---|---|
| Q1 — strict JSON parsing | `FAIL: strict request JSON must not schedule: unexpected /tmp/tmp.nNWS62WP31/fixture-23/run/osi-identity-restart.json` | The daemon uses firmware-provided `jsonfilter`, reconstructs the exact canonical object, and rejects trailing content, nesting, duplicate or unknown keys, wrong types, alternate ordering, and non-canonical cache or sentinel files. The test also pins `CONFIG_PACKAGE_jsonfilter=y` in `openwrt/osi-os.config`. |
| Q2 — numeric bounds | `FAIL: request validation accepted a leading-zero delay` | One unsigned-integer validator rejects signs, leading zeroes, non-digits, overlong values, and values above the 32-bit epoch limit before shell arithmetic. Delay is 1–300 seconds, requested epoch leaves room for the delay, and the maximum valid boundary is covered. |
| Q3 — lossless valid requests | `FAIL: request retained after sentinel publication failure: missing /tmp/tmp.MdtjlTrN3i/fixture-29/run/osi-node-red-restart-requests/retry-write.json` | A valid request is removed only after its scheduling decision is durably represented. Publication failures and blocking malformed sentinels retain the request for a later tick; invalid requests are warned and removed. |
| Q4 — canonical durable transition | `FAIL: noncanonical durable identity starts healing: missing /tmp/tmp.1mDhYxdNVt/fixture-8/state/sentinel-at-heal` | A durable EUI or confidence value whose raw UCI representation differs from its canonical value enters the same heal-before-restart transition as an identity change. Exact canonical readback remains mandatory after healing. |
| Q5 — monotonic deadlines | `FAIL: identity forward wall jump does not shorten warning: expected '', got 'restart'` | Restart warning and resolution cadence use `/proc/uptime`. Wall-clock timestamps are rebased from the remaining monotonic delay, so forward or backward clock corrections neither shorten nor extend the restart wait. |
| Q6 — malformed warning rate | `FAIL: unchanged malformed sentinel warning rate: expected '1', got '3'` | An unchanged malformed sentinel logs once. Content changes or a missing/recovered sentinel reset the warning fingerprint. The malformed file remains in place and never triggers a restart. |
| Q7 — restart completion recovery | `FAIL: sentinel retained after removal failure: missing /tmp/tmp.seQqZkIXDv/fixture-16/run/osi-identity-restart.json` | A successful service restart first copies the exact sentinel to an atomic completion marker. If sentinel removal fails, later ticks and daemon restarts finish cleanup without restarting Node-RED a second time. Failed service restarts do not create the marker. |
| Q8 — single consumer | `FAIL: single-consumer lock function is missing` | `start` and `run-once` use an atomic PID-owned lock. A live owner rejects another consumer, a dead owner is recovered through atomic directory takeover, and exit releases only the caller's lock. `request-restart` remains an unlocked producer. |

Final verification after Q1–Q8:

| Command | Result | Output evidence |
|---|---:|---|
| `sh scripts/test-osi-identityd.sh` | 0 | `PASS: osi-identityd state machine (17 scenarios)` |
| `sh -n` on both maintained daemon copies, followed by direct `diff` | 0 | No output |
| `sh scripts/test-gateway-identity-helper.sh` | 0 | `PASS: gateway identity heal ordering and state propagation` |
| `node scripts/verify-sync-flow.js` | 0 | `Sync flow verification passed`; chained parity ended `All parity checks passed.` |
| `node scripts/verify-profile-parity.js` | 0 | `All parity checks passed.` |
| `git diff --check` | 0 | No output; at this point the new files were still untracked, so this covered tracked changes only. |
| `git diff --no-index --check /dev/null <new-file>` for each of the three new files | 1 each | No output. Exit 1 reports that each file differs from `/dev/null`; these were diagnostics, not passing gates. |
| `node .claude/skills/anti-slop-writing/slop-check.js execution-report.md` | 0 | `slop-check: PASS (no tier-1 findings)` |

The final static review also found that `scripts/verify-profile-parity.js` used a fixed payload list that did not yet contain the new daemon. The check `node scripts/verify-profile-parity.js | rg -q 'files/usr/libexec/osi-identityd.sh'` exited 1. After adding the daemon to `CANONICAL_PAYLOAD`, the verifier reports `OK: files/usr/libexec/osi-identityd.sh` and still ends with `All parity checks passed.`

### Task 2 spec re-review follow-up

The next spec review found two daemon defects and one verification-report error.

| Review item | RED evidence | GREEN behavior |
|---|---|---|
| R1 — queued generic monotonic delay | `sh scripts/test-osi-identityd.sh` exited 1 with `FAIL: queued request forward wall jump does not restart immediately: expected '', got 'restart'`. | The request loader exports the validated delay and preserves the producer epoch only as `requestedAt` metadata. Consumption schedules `restartAtEpoch` from the current wall time and `restartNotBeforeUptime` from the current uptime. Forward and backward NTP-jump regressions each receive the full delay, while the existing burst case still keeps the earliest generic uptime deadline. |
| R2 — atomic lock ownership | The first focused run exited 1 with `FAIL: consumer lock was published without an atomic PID token`. | Lock publication is one `ln -s` operation whose token is the owner PID. The interleaving test pauses one contender before publication, lets the other acquire and hold the token, then confirms the paused contender is rejected. Live owners block; stale symlinks, legacy directories, and malformed entries are moved aside and recovered. Release moves the token to a caller-specific claim and deletes it only after the moved token still names the caller. |
| R2 legacy recovery discovered during GREEN | The first symlink implementation made `sh scripts/test-osi-identityd.sh` exit 1 without output. A trace showed `ln -s PID existing-directory` had created an entry inside the legacy directory and falsely reported acquisition. | `identityd_lock_create` now verifies that the lock path itself is the caller's symlink before setting `IDENTITYD_LOCK_HELD`; an accidental child entry is removed before stale takeover proceeds. |
| R3 — whitespace evidence | Each `git diff --no-index --check /dev/null <new-file>` invocation exited 1 with no output. | The three new files now have intent-to-add index entries. `git diff --check` therefore covers them and exits 0 with no output. No file content is staged; `git diff --cached --name-only` remains empty. |

The intent-to-add entries are visible as ` A` for both daemon copies and `scripts/test-osi-identityd.sh` in `git status --short`. The controller must preserve or clear that index metadata when it stages the final commit.

Final verification after R1–R3:

| Command | Exit | Output evidence |
|---|---:|---|
| `sh scripts/test-osi-identityd.sh` | 0 | `PASS: osi-identityd state machine (17 scenarios)` |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| Direct `diff` of the two daemon copies | 0 | No output |
| `sh scripts/test-gateway-identity-helper.sh` | 0 | `PASS: gateway identity heal ordering and state propagation` |
| `node scripts/verify-sync-flow.js` | 0 | `Sync flow verification passed`; chained profile verification reports `OK: files/usr/libexec/osi-identityd.sh` and ends `All parity checks passed.` |
| `node scripts/verify-profile-parity.js` | 0 | `OK: files/usr/libexec/osi-identityd.sh`; `All parity checks passed.` |
| `git diff --check` after `git add -N` for all three new files | 0 | No output |
| `test -z "$(git diff --cached --name-only)"` | 0 | No content staged |
| `node .claude/skills/anti-slop-writing/slop-check.js execution-report.md` | 0 | `slop-check: PASS (no tier-1 findings)` |
