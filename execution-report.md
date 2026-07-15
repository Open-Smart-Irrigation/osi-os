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

## Task 3 — OpenWrt supervision and bootstrap coordination

The static verifier was added before the service, enable script, bootstrap change, deploy wiring, or parity entries. Its first run exited 1 with 41 failures. The failures named the absent profile files, missing procd settings, old direct bootstrap restart, missing deploy fetches and service activation, and missing parity entries. The first and last failure groups were:

```text
FAIL missing required file: conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd
FAIL missing required file: conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable
FAIL conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap does not restart Node-RED directly; found "/etc/init.d/node-red restart"
FAIL scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/etc/init.d/osi-identityd; missing "'files/etc/init.d/osi-identityd'"
FAIL deploy.sh: starts identityd during live deploy; missing "/etc/init.d/osi-identityd start"
FAIL deploy.sh: identityd enable/start must follow flows, helpers, and GUI installation
41 live gateway identity verification failure(s)
EXIT_CODE=1
```

A second RED cycle covered the CI-chain contract. After temporarily removing the premature chain implementation, `node scripts/verify-live-gateway-identity.js` exited 1:

```text
FAIL scripts/verify-sync-flow.js: sync verification chains the live identity verifier; missing "[path.resolve(__dirname, 'verify-live-gateway-identity.js')]"
1 live gateway identity verification failure(s)
EXIT_CODE=1
```

The new rc.common service uses `START=98`, `STOP=98`, procd, and infinite respawn. Its `ready` command requires both a running procd instance and a daemon CLI check of the symlink lock's live PID owner. The verifier parses Node-RED's real `STOP=99` and requires identityd to stop first. The image enable script and all live-deploy copies use mode 755. Bootstrap checks identityd readiness immediately before publishing its 60-second `chirpstack_bootstrap` request; a readiness or request failure removes `/etc/osi-bootstrap.done` and leaves the one-shot eligible to retry.

Live deploy now stops identityd before its sole schema-migration call and waits until procd reports it absent and `/var/run/osi-identityd.lock` is absent, including a broken symlink. It leaves the request directory and restart sentinel in place. A single EXIT handler restores Node-RED first and then restores identityd to its prior running or stopped state on ordinary failures. Migration return code 3 disarms both restorations and leaves both services stopped. Final activation starts a fresh daemon after GUI extraction and disarms EXIT restoration only after the shared `ready` contract passes. The two direct deploy-time Node-RED restarts remain limited to the flow-payload flip and rollback paths.

The static verifier pins `jsonfilter` source revision `594cfa86469c005972ba750614f5b3f1af84d0f6` and procd source revision `42d3937654508b04da64969f9d764ac2ec411904`. The procd revision is the reviewed source for rcS's startup-list snapshot behavior. The verifier also requires `CONFIG_PACKAGE_jsonfilter=y`, the installed `/usr/bin/jsonfilter`, exact canonical JSON comparisons, `/proc/uptime`, `restartNotBeforeUptime`, and consumption-time monotonic scheduling.

Review found a factory-boot ordering gap in the original enable-only uci-default. S10boot applies `94_osi_identityd_enable` after rcS has captured its `S*` startup list, so a newly created `S98osi-identityd` link cannot join that boot's list. The corrected script records whether the link existed before enabling. If absent, it enables and starts identityd during the same S10boot run; if present, it leaves the already-queued S98 start alone. `/var/run` exists before uci-defaults execute, and an early provisional observation is safe because the daemon continues resolving after later defaults.

The pinned rc.common `start()` does not propagate `rc_procd start_service` failure unless the service defines a `service_started` hook. A reproduction used the checked-in control flow with `start_service` returning 7; the wrapper still returned 0:

```text
MASKED_START_EXIT=0
```

The uci-default therefore treats only `enable` status directly. After the same-boot `start`, it checks `/etc/init.d/osi-identityd ready` up to five times at one-second intervals and exits 1 if no live lock owner appears. The checked-in `uci_apply_defaults` implementation retains the failed file for the next boot. Live deploy uses the same bounded readiness contract after a proven lock-absence gap.

The new factory-boot assertions failed before the enable script changed: the verifier reported four missing pre-enable snapshot and conditional-start contracts and exited 1. A following assertion-first run for the intended enable/start failure paths reported six missing contract or ordering checks and exited 1. The first running postcondition assertions failed with eight findings. Lifecycle TDD then produced `identityd ready function is missing` from the daemon test and 42 static-verifier findings before the lifecycle implementation. The pre-existing migration wiring test exposed stale trap expectations at 5 passing tests out of 6; its lifecycle-aware contract now passes 6 out of 6.

The complete mutation sweep produced these RED results:

| Mutation | Verifier failure |
|---|---|
| Replace the checked-in jsonfilter source revision with zeroes | `pins the reviewed jsonfilter source revision` |
| Replace the checked-in procd source revision with zeroes | `pins the reviewed procd rcS snapshot semantics` |
| Insert an operation between the live payload-flip log and Node-RED restart | `retains the direct Node-RED restart immediately after the live payload flip and its existing log` |
| Activate identityd before flows staging, payload activation, and GUI extraction | Three ordered-activation failures for those prerequisites |
| Replace both first-boot `running` checks with `true` | Six missing first-boot postcondition or ordering failures |
| Replace the deploy `running` check with `true` | Two missing deploy postcondition or ordering failures |
| Remove quiescence immediately before migration | One missing lifecycle-fence failure |
| Set Node-RED `STOP=97` below identityd's `STOP=98` | Two real-profile shutdown-order failures |
| Remove the ready predicate's `kill -0` | The initial verifier escaped the mutation; after tightening the exact function contract, both profiles failed |
| Replace final fresh readiness with procd `running` | Two final-activation failures |
| Replace bootstrap `ready` with `running` | Two live-consumer failures |
| Restore identityd before Node-RED in the EXIT handler | One static ordering failure and a lifecycle-harness failure |

Each mutation was reverted before the green run. The verifier now checks the gateway identity helper and daemon installation, flows staging and activation, and GUI extraction independently before identityd activation.

### Shell and service gate

| Command | Exit | Observed output/pass signal |
|---|---:|---|
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap` | 0 | No output |
| `sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap` | 0 | No output |
| `sh -n deploy.sh` | 0 | No output |
| `sh -n scripts/test-osi-identityd.sh` | 0 | No output |
| `sh -n scripts/test-identityd-service-lifecycle.sh` | 0 | No output |
| `sh scripts/test-gateway-identity-helper.sh` | 0 | `PASS: gateway identity heal ordering and state propagation` |
| `sh scripts/test-osi-identityd.sh` | 0 | `PASS: osi-identityd state machine (17 scenarios)` |
| `sh scripts/test-identityd-service-lifecycle.sh` | 0 | `PASS: identityd deploy lifecycle and readiness` |
| `node scripts/test-deploy-migration-wiring.js` | 0 | Six tests passed; zero failed |
| `node scripts/verify-live-gateway-identity.js` | 0 | All listed service, deploy, parity, package-source, strict-JSON, and monotonic-clock assertions reported `OK`; final line `Live gateway identity verification passed.` |
| `node scripts/verify-profile-parity.js` | 0 | New paths `osi-bootstrap`, `osi-identityd`, `94_osi_identityd_enable`, and `osi-identityd.sh` reported `OK`; final line `All parity checks passed.` |
| `git diff --check` | 0 | No output |

### Full flows gate

| Command | Exit | Observed output/pass signal |
|---|---:|---|
| `node scripts/verify-sync-flow.js` | 0 | Existing detailed assertions reported `OK`; `Sync flow verification passed`; chained live identity verification passed; chained parity ended `All parity checks passed.` |
| `node scripts/verify-communication-contract.js` | 0 | `Communication contract verification passed` |
| `node scripts/verify-profile-parity.js` | 0 | All canonical paths reported `OK`; final line `All parity checks passed.` |
| `node scripts/verify-flows-fn-parse.js` | 0 | Maintained profiles: 240 nodes and 240 parsed sources each; bcm2708: 64 and 64; `verify-flows-fn-parse: OK` |
| `node scripts/verify-no-new-silent-catch.js` | 0 | bcm2712 and bcm2709 each: 225 empty catches, baseline 225 |
| `node scripts/verify-flows-size-ratchet.js` | 0 | Both maintained profiles: 1,052,778 bytes; `verify-flows-size-ratchet: OK` |
| `node scripts/flows-bare-require-scan.js` | 0 | No output |
| `node scripts/test-flows-wiring.js` | 0 | All listed wiring assertions reported `OK`; final line `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed` |
| `node scripts/verify-no-stray-ddl.js` | 0 | `verify-no-stray-ddl: OK (HEAD total 702 <= origin/main total 702; committed baseline matches HEAD total 702)` |
| `scripts/check-mqtt-topics.sh` | 0 | All three profile flow copies reported no UUID patterns in MQTT IN topics |
| `node scripts/verify-live-gateway-identity.js` | 0 | All listed service, deploy, parity, package-source, strict-JSON, and monotonic-clock assertions reported `OK`; final line `Live gateway identity verification passed.` |
| `git diff --check` | 0 | No output |

The six new files have intent-to-add entries, so `git diff --check` covers their content. `git diff --cached --name-only` produced no output; no content is staged. The final `execution-report.md` prose check exited 0 with `slop-check: PASS (no tier-1 findings)`.
