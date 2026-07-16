# Live gateway identity (Option C) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Stop on the first unexpected result or red gate.

**Goal:** Make gateway identity converge after boot, then switch Node-RED, MQTT, sync triggers, link, and sync to the healed identity in one warned restart.

**Architecture:** A procd daemon resolves identity outside Node-RED, heals UCI with the existing shell helper, and writes atomic tmpfs state. Identity-coupled Node-RED consumers keep using their boot environment; while a transition is being healed or waiting for restart, they see a fail-closed sentinel and do no link or sync work. After the 60 s warning, the daemon restarts Node-RED and removes the sentinel only when the restart command succeeds. ChirpStack registration is a separate idempotent reconciliation loop, not a one-shot transition hook.

**Tech Stack:** BusyBox `ash`, OpenWrt rc.common/procd, Node.js with native `@grpc/grpc-js`, Node-RED function nodes, React 18, TypeScript, i18next, and Vitest.

---

## Review corrections incorporated

The companion design spec is authoritative for behavior; this plan is authoritative for task order, file scope, and gates. They use the same contracts:

1. `heal` is `resolve -> repair -> resolve -> persist`. `repair` reads process-local globals populated by the first resolve.
2. A live candidate is not active Node-RED identity. The seven consumers keep using the boot environment and block on the restart sentinel. `DEVICE_EUI`, MQTT credentials/client ID, `sync-init-fn` triggers, link requests, and sync requests switch together.
3. A transition is keyed by EUI and confidence. A provisional-to-authoritative promotion with the same EUI fires. A zero `heal` exit is not enough: the daemon validates the final non-provisional result and durable UCI readback before scheduling a restart.
4. A deadline-free `healing` sentinel is recoverable state. It drives healing after a daemon crash even when UCI already matches the target; an overdue `restart_pending` deadline causes an immediate restart attempt.
5. ChirpStack registration retries independently for every stable non-provisional EUI, including gateways that were authoritative before this feature shipped. Registration accepts only cache phase `active` or `restart_pending`, never `healing`.
6. Slice 3 extracts only the restart-sentinel reader. It must not move or edit `runGatewayMigrationPreflight`.

## Delivery boundaries

- **PR A:** Slices 1 and 1b. This is independently shippable and fixes fresh-flash identity convergence plus the warned restart.
- **PR B:** Slice 2, stacked on PR A or based on `main` after PR A merges. It adds ChirpStack gateway registration.
- **PR C:** Slice 3 after PRs A and B. It contains only the behavior-preserving Node-RED helper extraction.
- Do not squash these boundaries into one PR. Preserve the dependency chain if PR B is stacked.

## Runtime contracts

### Live identity cache

`/var/run/osi-gateway-identity.json` is written only by `osi-identityd`, using a same-directory temporary file and `mv`:

```json
{
  "deviceEui": "0016C001F116EBF2",
  "source": "concentratord-runtime",
  "confidence": "authoritative",
  "lastVerifiedAt": "2026-07-15T12:00:00Z",
  "linkGatewayDeviceEui": null,
  "phase": "active",
  "updatedAt": "2026-07-15T12:00:00Z"
}
```

Allowed `phase` values are `provisional`, `active`, `healing`, and `restart_pending`. Node-RED does not use the cache's EUI before restart. The phase is consumed by observability and ChirpStack registration; registration accepts only `active` or `restart_pending` with non-provisional confidence.

### Restart sentinel

`/var/run/osi-identity-restart.json` exists from the moment a transition or coordinated bootstrap restart begins until `/etc/init.d/node-red restart` exits zero:

```json
{
  "phase": "restart_pending",
  "restartAt": "2026-07-15T12:01:00Z",
  "restartAtEpoch": 1784116860,
  "reason": "gateway_identity_change",
  "targetDeviceEui": "0016C001F116EBF2",
  "requestedAt": "2026-07-15T12:00:00Z"
}
```

During `healing`, `restartAt` and `restartAtEpoch` are `null`. The public stats endpoint exposes only `restartAt` and `reason`. An existing but unreadable sentinel blocks link/sync and emits `node.warn`; it never falls open. On daemon start, a `healing` sentinel reruns heal and post-heal validation regardless of whether durable UCI already matches its target. A `restart_pending` sentinel with `restartAtEpoch <= now` causes an immediate restart attempt.

### Restart requests

`osi-bootstrap` no longer restarts Node-RED itself. It calls:

```sh
/usr/libexec/osi-identityd.sh request-restart chirpstack_bootstrap 60
```

The request subcommand atomically adds a uniquely named JSON file under `/var/run/osi-node-red-restart-requests/`. The account-link and account-unlink restart nodes add the same request shape through `global.get('fs')`, keyed by their sanitized `msg._msgid`; they no longer spawn shell processes:

```json
{"reason":"account_link","delaySeconds":10,"requestedAtEpoch":1784116800}
```

A directory avoids last-writer-wins loss when bootstrap and account state change together. The daemon consumes every file once per control tick and remains the only writer of the live cache and restart sentinel. Among generic requests, it keeps the earliest deadline. A `gateway_identity_change` request has priority and receives a new full 60 s warning from the identity detection time; bootstrap, link, and unlink requests cannot shorten it.

### BusyBox time conversion

The built BusyBox 1.36.1 configuration enables `date -d` and accepts `@epoch`. Do not use GNU relative-date syntax or a current-time fallback:

```sh
restart_epoch=$((now_epoch + 60))
restart_at="$(date -u -d "@$restart_epoch" +%Y-%m-%dT%H:%M:%SZ)" || return 1
```

Re-run this exact command on the approved test Pi before accepting the live smoke test.

## Global constraints

- `bcm2712` is canonical. Mirror every file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` byte-identically to `conf/full_raspberrypi_bcm27xx_bcm2709/files/`.
- Add every new mirrored payload path to `scripts/verify-profile-parity.js`; a manual `diff` is additional evidence, not a substitute.
- Edit `flows.json` only with a throwaway roundtrip-guarded Node script outside the repository. Prove the no-op serialization is byte-identical before mutation, write both profiles, reparse both, and assert only named node `func` values changed.
- For every touched function node, replace all existing empty/comment-only catches with visible `node.warn(...)` handling. Update `scripts/fixtures/silent-catch-baseline.json` downward in the same commit.
- Function-node changes may use `global.get('fs')` or `osiLib.require()`. They must not add or use `child_process`, `global.get('cp')`, or bare `require()`.
- Update existing node-growth allowances rather than adding duplicate JSON keys. Increase `total_allowance.delta` by the exact net positive growth and append the reason. If total embedded JS shrinks, do not manufacture an allowance.
- Do not edit `sync-init-fn`, any copy of `runGatewayMigrationPreflight`, or `/api/system/reboot`.
- Do not access `osicloud.ch`. Live checks use the approved disposable/bench gateway only.
- Write every command, complete output, and its own exit code to `execution-report.md`. Do not prove success through a pipe.
- If a base gate is red, record `red-on-base` and stop before Task 1. If a task gate is red, stop before committing or starting the next task.

## Gate sets

### Shell and service gate

Run each command separately:

```sh
sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh
sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh
sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh
sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh
sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd
sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd
sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap
sh -n conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap
sh -n deploy.sh
sh scripts/test-gateway-identity-helper.sh
sh scripts/test-osi-identityd.sh
node scripts/verify-live-gateway-identity.js
node scripts/verify-profile-parity.js
git diff --check
```

Every command must exit 0. `verify-profile-parity` must end with `All parity checks passed.`

### Flows gate

```sh
node scripts/verify-sync-flow.js
node scripts/verify-communication-contract.js
node scripts/verify-profile-parity.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/test-flows-wiring.js
node scripts/verify-no-stray-ddl.js
scripts/check-mqtt-topics.sh
node scripts/verify-live-gateway-identity.js
git diff --check
```

Every command must exit 0. The flow editor's pre- and post-write roundtrip output is part of this gate.

`scripts/verify-live-gateway-identity.js` is created in Task 3. Task 0 runs every command in this gate except that future verifier; after Task 3, no exception is allowed. The two new shell tests in the shell/service gate are likewise unavailable until their creating tasks.

### GUI gate

Run from `web/react-gui`:

```sh
npm run typecheck
npm run test:unit
npm run build
```

Then run `git diff --check` from the repository root. Every command must exit 0.

## Execution preflight

### Task 0: Record the base and prove every required gate starts green

**Files:**

- Create during execution: `execution-report.md`
- Read: `docs/superpowers/specs/2026-07-14-live-gateway-identity-design.md`
- Read: this plan

- [ ] **Step 1: Record provenance.** Run `git status --short --branch`, `git rev-parse HEAD`, and `git log -1 --oneline`. The only expected pre-existing untracked files are the supplied spec and plan; stop on unrelated modifications that overlap this work.
- [ ] **Step 2: Run the base-compatible flows gate against the unmodified base.** Run every command in the flows gate except `node scripts/verify-live-gateway-identity.js`, which does not exist until Task 3. Record each exit code separately and stop on any non-zero result. Do not classify the intentionally omitted future verifier as red-on-base.
- [ ] **Step 3: Run the GUI gate against the unmodified base.** Stop on any non-zero result.
- [ ] **Step 4: Record current ratchets.** On reviewed base `553920e1`, `verify-no-new-silent-catch` reports 225 for each maintained profile and `verify-profile-parity` passes. If the execution base differs, the executor must use the measured count and recalculate every later downward target. Hardcoded review-time numbers never override Task 0 evidence.
- [ ] **Step 5: Commit nothing.** Task 0 is evidence only.

## Slice 1: live healing and one coherent identity switch

### Task 1: Add and test the correctly ordered `heal` operation

**Files:**

- Create: `scripts/test-gateway-identity-helper.sh`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh`
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`

- [ ] **Step 1: Write the failing shell test.** Source the canonical helper, replace the four operations with stubs, and assert the call order and failure behavior:

```sh
order=""
gateway_identity_resolve() { order="${order} resolve"; return 0; }
gateway_identity_repair_concentratord_config() { order="${order} repair"; return 0; }
gateway_identity_persist() { order="${order} persist"; return 0; }
gateway_identity_heal
[ "$order" = " resolve repair resolve persist" ]
```

Add cases where the first resolve, repair, second resolve, and persist each fail. `gateway_identity_heal` must return non-zero immediately and must not call later operations.

Add one state-propagation case using the production `gateway_identity_repair_concentratord_config` with a stubbed `uci` command: the first resolve sets `GATEWAY_IDENTITY_DEVICE_EUI` and confidence, repair must write that EUI to the active concentratord section, and a provisional value must produce no write. This proves the globals consumed by repair, not only the call order.
- [ ] **Step 2: Run `sh scripts/test-gateway-identity-helper.sh`.** Expected: non-zero with `gateway_identity_heal: not found`.
- [ ] **Step 3: Implement the helper function and subcommand.** The production body is exactly:

```sh
gateway_identity_heal() {
    gateway_identity_resolve || return 1
    gateway_identity_repair_concentratord_config || return 1
    gateway_identity_resolve || return 1
    gateway_identity_persist || return 1
}
```

Add `heal)` to the existing command dispatch, call `gateway_identity_heal`, then emit the shell fields. Mirror the full file byte-identically.
- [ ] **Step 4: Use the same function in `node-red.init`.** Replace its four best-effort calls with `gateway_identity_heal`. On failure, log `gateway identity heal failed; resolving best available identity` and call `gateway_identity_resolve || true` so Node-RED retains today's provisional fallback instead of starting with empty values.
- [ ] **Step 5: Run the helper test, `sh -n` on all three changed shell files, `node scripts/verify-communication-contract.js`, profile parity, and `git diff --check`.** Every command exits 0.
- [ ] **Step 6: Commit.** Use `fix: share correctly ordered gateway identity heal`.

### Task 2: Build the daemon state machine test-first

**Files:**

- Create: `scripts/test-osi-identityd.sh`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh`

The daemon may expose `run-once` and `request-restart` subcommands for deterministic tests. Production `start` loops forever. Test-only path overrides must be limited to `OSI_IDENTITY_RUN_DIR`, `OSI_IDENTITY_HELPER`, `OSI_NODE_RED_SERVICE`, and `OSI_REGISTRATION_SCRIPT`; production defaults remain the paths in Runtime contracts.

- [ ] **Step 1: Write the failing state-machine test.** Stub identity resolution, UCI, Node-RED restart, the clock, and sleep. Cover these exact cases:

  1. provisional identity writes `phase=provisional`, creates no restart sentinel, and uses 10 s cadence for the first 600 s;
  2. the same EUI promoted from durable `provisional` to resolved `authoritative` writes `phase=healing` before calling `heal`;
  3. a different non-provisional EUI follows the same transition;
  4. failed `heal` leaves `phase=healing`, has no `restartAt`, and never invokes Node-RED restart;
  5. `heal` exit 0 with a final provisional EUI leaves `phase=healing`, creates no deadline, and retries after 10 s;
  6. `heal` exit 0 with a durable UCI readback that does not match the final helper globals behaves the same way;
  7. a final non-provisional EUI that differs from the initially detected candidate atomically retargets the sentinel, and a matching durable readback schedules that final EUI;
  8. a validated heal sets `restartAtEpoch=now+60` and formats it through `date -u -d @epoch`;
  9. a daemon restart with a deadline-free `healing` sentinel reruns heal and validation even when UCI already matches the target, covering death after persist but before scheduling;
  10. a daemon restart with a future `restart_pending` sentinel resumes the original deadline without scheduling a second transition;
  11. an existing `restart_pending` sentinel whose deadline is due or overdue attempts Node-RED restart on the next control tick;
  12. restart exit 0 removes the sentinel and writes `active` (or `provisional` for a bootstrap-only restart);
  13. restart failure keeps the sentinel, schedules a retry 30 s later, and does not stamp success;
  14. `chirpstack_bootstrap`, `account_link`, and `account_unlink` requests cannot shorten a pending identity deadline;
  15. a later identity transition supersedes any of those reasons and gets a new full 60 s warning;
  16. every file in a multi-request burst is consumed, with the earliest generic deadline retained;
  17. a restart request is consumed within one control tick even when the next identity resolve is 300 s away.

- [ ] **Step 2: Run `sh scripts/test-osi-identityd.sh`.** Expected: non-zero because `osi-identityd.sh` does not exist.
- [ ] **Step 3: Implement atomic JSON writers.** Use `umask 077`, a temporary file in the same run directory, and `mv`. JSON values originate only from normalized helper output or fixed reason enums. Do not interpolate arbitrary CLI text into JSON.
- [ ] **Step 4: Implement transition detection.** Read the durable EUI and confidence before healing. Trigger when the resolved identity is non-provisional and either the EUI differs or durable confidence is provisional/empty. Write the `healing` sentinel before the first UCI mutation. If a `healing` sentinel already exists, resume it before ordinary persisted-vs-resolved detection so a crash after persist cannot strand the gates.
- [ ] **Step 5: Validate the post-heal identity before scheduling.** After `gateway_identity_heal` returns 0, normalize the final helper globals, require confidence other than `provisional`, and read back `osi-server.cloud.device_eui` plus `device_eui_confidence`. Both readback values must match the final helper EUI and confidence exactly. If the final valid EUI differs from the sentinel target, atomically retarget the sentinel before adding the deadline. Any validation failure keeps `phase=healing`, leaves both deadline fields null, and retries after 10 s.
- [ ] **Step 6: Implement restart scheduling and recovery.** Add the 60 s deadline only after Step 5 succeeds. On startup, retain a future existing deadline; attempt an expired deadline on the next control tick. Remove the sentinel only after `/etc/init.d/node-red restart` returns 0. On failure, retain it with a deadline 30 s in the future. Do not use a once-per-boot stamp: the target-keyed sentinel prevents duplicate scheduling while allowing a second real EUI transition in one boot.
- [ ] **Step 7: Implement a one-second control tick with adaptive resolution.** Every control tick checks restart state and the request directory. Resolve identity every 10 s for the first 600 continuous provisional seconds, then every 300 s; use 300 s when non-provisional. Failed or incomplete healing retries every 10 s. Do not sleep for the full resolve interval because link/unlink restart requests and overdue deadlines must remain responsive.
- [ ] **Step 8: Implement `request-restart`.** Accept only `gateway_identity_change`, `chirpstack_bootstrap`, `account_link`, and `account_unlink`; accept integer delays from 1 through 300. Atomically add one uniquely named file to the request directory. The long-running daemon consumes and deletes every request within one control tick.
- [ ] **Step 9: Run the shell test and `sh -n` on both copies.** Confirm `diff` produces no output and both commands exit 0.
- [ ] **Step 10: Commit.** Use `feat: add live gateway identity state machine`.

### Task 3: Add procd, bootstrap coordination, deploy coverage, and parity enforcement

**Files:**

- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable`
- Modify: both profile copies of `files/etc/init.d/osi-bootstrap`
- Modify: `deploy.sh`
- Modify: `scripts/verify-profile-parity.js`
- Create: `scripts/verify-live-gateway-identity.js`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Write the failing static verifier.** Assert all new files exist in both profiles, appear in `CANONICAL_PAYLOAD`, carry the expected executable mode, and are installed by `deploy.sh`. Assert identityd has `START=98`, `USE_PROCD=1`, `respawn`, and command `/usr/libexec/osi-identityd.sh start`. Assert `osi-bootstrap` contains `request-restart chirpstack_bootstrap 60` and no executed `/etc/init.d/node-red restart`. Pin `deploy.sh`'s existing direct restart after the flow-payload flip and its rollback restart so this task cannot remove them while centralizing identity-owned restarts.
- [ ] **Step 2: Run `node scripts/verify-live-gateway-identity.js`.** Expected: non-zero listing the missing service/deploy contracts.
- [ ] **Step 3: Add the service and enable script.** Follow the procd structure in `node-red.init`, not the non-procd `osi-bootstrap` script. `94_osi_identityd_enable` runs `/etc/init.d/osi-identityd enable`.
- [ ] **Step 4: Coordinate bootstrap restart.** After successful ChirpStack provisioning, request the 60 s restart from identityd. If the request fails, remove `/etc/osi-bootstrap.done`, log that bootstrap will retry, and return without a direct restart. This keeps one restart owner and avoids losing the required restart behind a valid stamp.
- [ ] **Step 5: Extend `deploy.sh`.** Install/chmod the daemon, service, enable script, and updated `osi-bootstrap`; enable identityd and start/restart it only after flows, helpers, and GUI are installed. Preserve the farming database guard and the existing direct Node-RED restarts used to load a flipped flow payload and to roll back a failed health check. Do not add a direct identity-transition, bootstrap, account-link, or account-unlink restart to `deploy.sh`; those go through identityd.
- [ ] **Step 6: Extend parity enforcement.** Add the three new mirrored paths to `CANONICAL_PAYLOAD`. Chain `verify-live-gateway-identity.js` from `verify-sync-flow.js` so CI cannot omit it.
- [ ] **Step 7: Run the shell and service gate.** Record complete output and exits. Stop on red.
- [ ] **Step 8: Commit.** Use `feat: supervise live gateway identity on OpenWrt`.

### Task 4: Pause link and sync while identity is changing

**Files:**

- Modify via `/tmp/osi-live-identity-flow-edit.js`: both maintained `flows.json` copies
- Modify: `scripts/verify-live-gateway-identity.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/test-journal-bootstrap.js`
- Modify: `scripts/fixtures/silent-catch-baseline.json`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Identity-gate nodes:** `sync-bootstrap-build`, `sync-outbox-build`, `sync-pending-build`, `sync-force-build`, `command-ack-build-batch`, `sync-state-build`, and `al-link-build-req`.

**Restart-owner nodes:** `al-link-restart-node-red` and `al-unlink-restart-node-red`.

Do not touch `al-link-validate`; its existing `global.get('cp')` path is outside this change. Remove child process from both restart-owner nodes, and do not introduce it anywhere else.

`al-link-validate` may finish token and URL validation before `al-link-build-req` sees the sentinel. On a fresh flash it may reject the provisional boot identity first. Both outcomes are accepted because no cloud request is sent; do not add a sentinel read or otherwise optimize `al-link-validate` in this slice.

Each touched node receives this local reader in Slice 1:

```js
function gatewayIdentityRestartPending() {
  const fs = global.get('fs');
  if (!fs) {
    node.warn('Gateway identity restart check: fs global is unavailable; blocking identity-sensitive work');
    return true;
  }
  const statePath = '/var/run/osi-identity-restart.json';
  if (!fs.existsSync(statePath)) return false;
  try {
    JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return true;
  } catch (error) {
    node.warn('Gateway identity restart state is unreadable; blocking identity-sensitive work: ' + String(error && error.message ? error.message : error));
    return true;
  }
}
```

- [ ] **Step 1: Add failing verifier assertions.** Require the sentinel path in exactly the seven identity-gate nodes. Require the four sync builders to throw status 503 before `currentGatewayIdentity()`, command ACK to return `null`, `al-link-build-req` to return its second/error output with status 503, and sync state to expose `restartPending`. Execute the bootstrap builder with a present sentinel and assert the final `sync_state.lastError.source` remains `gateway-identity`; a substring check is insufficient because the outer catch can overwrite it. Require the two restart-owner nodes to write unique request files atomically with reasons `account_link`/`account_unlink` and delays 10/2, respectively, with no `global.get('cp')`, `spawn`, or executed service command. Execute both restart-owner functions with a mocked `fs`: hostile `msg._msgid` input must stay inside the request directory, distinct IDs must produce distinct final paths, the JSON must have exactly the three reviewed fields, directory creation must use mode `0700`, and publication must rename a unique mode-`0600` temporary file to the message-keyed final path. Add missing-`fs`, `mkdir`, write, rename, and overlong-ID cases. Every failure must set a red status, return an HTTP 503 only through the error output, and avoid the success-only clear/bootstrap branches. Replace `verify-sync-flow.js`'s current `/etc/init.d/node-red restart` pin with this request-file contract. Assert `al-link-validate`, `sync-init-fn`, and every `runGatewayMigrationPreflight` function body are byte-identical to the pre-edit snapshot. Update the existing journal/bootstrap behavior harness to provide the reviewed `fs` global with a missing sentinel for its success fixtures, and add present and malformed sentinel cases that prove bootstrap and force-sync fail closed.
- [ ] **Step 2: Run the verifier.** Expected: non-zero because no node reads the sentinel.
- [ ] **Step 3: Prove no-op roundtrip identity for both flow files.** The throwaway script prints file byte counts and `byte-identical: true` before mutation. Stop if either is false.
- [ ] **Step 4: Mutate only the nine named nodes.** The four sync builders set the existing `gateway-identity` error state and throw 503 before reading the boot identity. The bootstrap builder marks the thrown identity error and uses that marker in its outer catch to preserve the source for this path; it must not infer the source from an ambient `sync_state.lastError`, which may be stale. `command-ack-build-batch` returns `null`. `al-link-build-req` clears `al_server_password`, then returns `[null, msg]` with `Gateway identity is being applied. The central hub will restart before linking.` `sync-state-build` reports the boolean without substituting the candidate EUI. The two restart-owner nodes accept only non-empty message IDs whose UTF-8 encoding is at most 64 bytes, encode that bounded value into a deterministic path-confined final filename, use a separate unique temporary filename so an abandoned temp file cannot block a retry, create the request directory with mode `0700`, and atomically write request JSON through `global.get('fs')`. Their success output retains the existing fan-out. Add a second output wired only to the matching HTTP response; validation or filesystem failure sets status 503, a bounded error payload, and a red node status, then returns only through that output. It must not reach state clear or link bootstrap. Preserve each node's existing `libs` value: the restart-owner nodes remain `[]`, and `fs` is not added as an external module.
- [ ] **Step 5: Remove the seven silent catches outside frozen migration preflight code.** On reviewed base `553920e1`, the seven identity-gate nodes contain 9 silent catches, but 2 of `sync-pending-build`'s 3 catches are inside `runGatewayMigrationPreflight` and must remain byte-identical under the global constraint. Clean the remaining 7: `sync-pending-build` 1, `command-ack-build-batch` 2, `sync-state-build` 3, and `al-link-build-req` 1. The other three and both restart-owner nodes contain none. Removing those 7 changes each profile baseline from 225 to 218. Set `generatedFrom` to this task. If Task 0 measured different counts, ignore these review-time targets and subtract exactly the number outside the frozen bodies that the verifier reports removed from the measured base.
- [ ] **Step 6: Update growth allowances mechanically.** Measure each changed function's UTF-8 byte delta before/after. Increment existing entries for `sync-bootstrap-build`, `sync-outbox-build`, and `sync-force-build`; create entries for the other growing nodes. Increase `total_allowance.delta` by the exact positive net growth and append `live identity restart sentinel (Option C Slice 1)` to its reason. Never duplicate an existing node key.
- [ ] **Step 7: Reparse both outputs and prove only the nine named nodes changed.** For all nine, allow only `func` to differ except that each restart-owner node also changes `outputs` from 1 to 2 and adds the matching HTTP-response node as its error-only wire. Confirm every other field and node is unchanged and the profile files are byte-identical.
- [ ] **Step 8: Run the complete flows gate.** Stop on red.
- [ ] **Step 9: Commit.** Use `fix: pause identity-sensitive flows until restart`.

Requests already past the new sentinel check may finish with the old boot identity. This is accepted behavior: they remain on the same generation as MQTT and the boot trigger, and existing retry/deduplication plus post-restart migration preflight handle incomplete delivery.

## Slice 1b: operator warning and GUI countdown

### Task 5: Expose a filtered restart status from system stats

**Files:**

- Modify via a new throwaway roundtrip script: both `flows.json` copies, node `sys-stats-fn`
- Modify: `scripts/verify-live-gateway-identity.js`
- Modify: `scripts/fixtures/silent-catch-baseline.json`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

- [ ] **Step 1: Add failing executable verifier cases.** Run `sys-stats-fn` in a harness with mocked `os`, `fs`, `node`, and shared node context. Assert missing file -> `restartPending:null`; valid file -> only `{restartAt,reason}`; malformed file -> `null` plus a warning; fields such as `targetDeviceEui` never reach the response. Statically allow only `restartAt` and `reason` property reads from the parsed sentinel, and explicitly reject the canonical non-public fields `phase`, `restartAtEpoch`, `restartNotBeforeUptime`, `targetDeviceEui`, and `requestedAt` so a conditional leak cannot evade the fixtures. Invoke the same function repeatedly with shared context: expected fan-path absence (`ENOENT`/`ENOTDIR`) must retain HTTP 200 and `fan_available:false` without repeated warnings; a persistent unexpected error such as `EACCES` or `EIO` warns once per path/signature; a changed error warns again; and successful recovery clears the remembered signature so a later recurrence warns once again. Simulate hwmon hotplug churn across more paths than the configured context-map limit: entries for disappeared `hwmonN/name` paths must be pruned after a successful directory read, and the map must remain capped even while directory reads fail and pruning is impossible.
- [ ] **Step 2: Run the verifier.** Expected: non-zero because `restartPending` is absent.
- [ ] **Step 3: Mutate `sys-stats-fn`.** Read the sentinel only when it exists, catch malformed/read errors visibly, and add this response field. Preserve the node's absent `libs` property; `global.get('fs')` does not require an external-module declaration.

```js
restartPending: restartState && restartState.restartAt
  ? { restartAt: String(restartState.restartAt), reason: String(restartState.reason || 'gateway_identity_change') }
  : null
```

- [ ] **Step 4: Clean its three existing silent fan-detection catches.** Warn unexpected failures with the probed path/context and retain the current fallback behavior. Treat `ENOENT`/`ENOTDIR` as normal absence. Deduplicate persistent unexpected failures by path and bounded error signature in node context, and clear the remembered signature after that probe recovers so a later regression is visible. Cap the remembered map at 32 entries and, after each successful `/sys/class/hwmon` directory read, prune stored `hwmonN/name` paths that are no longer present. On reviewed base `553920e1`, lower each profile baseline from 218 to 215. If Task 0 or Task 4 measured different counts, subtract 3 from the actual post-Task-4 baseline instead.
- [ ] **Step 5: Update the `sys-stats-fn` and total size allowances by measured net byte growth.** Use reason `filtered restartPending status (Option C Slice 1b)`.
- [ ] **Step 6: Run the complete flows gate.** Stop on red.
- [ ] **Step 7: Commit.** Use `feat: expose pending gateway restart status`.

### Task 6: Add the accessible global countdown banner

**Files:**

- Modify: `web/react-gui/src/services/api.ts`
- Create: `web/react-gui/src/hooks/useSystemStatus.ts`
- Create: `web/react-gui/src/components/GatewayRestartBanner.tsx`
- Create: `web/react-gui/src/components/__tests__/GatewayRestartBanner.test.tsx`
- Modify: `web/react-gui/src/App.tsx`
- Modify: `web/react-gui/public/locales/en/common.json`
- Modify: `web/react-gui/public/locales/de-CH/common.json`
- Modify: `web/react-gui/public/locales/fr/common.json`
- Modify: `web/react-gui/public/locales/it/common.json`
- Modify: `web/react-gui/public/locales/es/common.json`
- Modify: `web/react-gui/public/locales/pt/common.json`
- Modify: `web/react-gui/public/locales/lg/common.json`

- [ ] **Step 1: Write failing component tests.** Mock `systemAPI.getStats`, use fake timers, and cover future countdown, decrement after one second, `null`, invalid timestamp, an already-expired pending timestamp rendering the in-progress message, API error, and interval cleanup on unmount. Assert `role="status"` and `aria-live="polite"`.
- [ ] **Step 2: Run only `GatewayRestartBanner.test.tsx`.** Expected: failure because the component is missing.
- [ ] **Step 3: Extend the service type.** Add:

```ts
restartPending?: {
  restartAt: string;
  reason: 'gateway_identity_change' | 'chirpstack_bootstrap' | string;
} | null;
```

- [ ] **Step 4: Implement `useSystemStatus`.** Fetch immediately, poll every 30 s, keep the last successful stats during a transient error, and clear the interval on unmount. Do not duplicate auth or response normalization outside `api.ts`.
- [ ] **Step 5: Implement the banner.** Parse the absolute timestamp once per response, update remaining seconds every second, render nothing for missing or invalid values, and render an in-progress message at zero or for an already-expired pending deadline until the next successful API poll clears the state. Map known reasons to their own keys and unknown reasons to `restart.generic`. Mount it inside `AuthProvider` and above `HashRouter`, preserving the current router and global Suspense behavior.
- [ ] **Step 6: Add locale keys at the verified source path.** Use `restart.gateway_identity_change`, `restart.chirpstack_bootstrap`, `restart.account_link`, `restart.account_unlink`, `restart.generic`, and `restart.in_progress`. Add keys to all seven `public/locales/<lng>/common.json` files. English fallback is allowed for `lg` in this PR; do not invent an unreviewed Luganda translation.
- [ ] **Step 7: Run the focused test, then the complete GUI gate.** Confirm `build/locales/en/common.json` contains all six restart keys. Stop on red.
- [ ] **Step 8: Commit.** Use `feat: warn before gateway identity restart`.

### Task 7: Finish PR A documentation and local verification

**Files:**

- Modify: `AGENTS.md`
- Modify: `.claude/skills/osi-config-and-flags/SKILL.md`
- Modify: `CHANGELOG.md`
- Modify: `execution-report.md`

- [ ] **Step 1: Document the shipped contracts.** Record daemon/service paths, cache and sentinel paths, transition phases, the 60 s restart, bootstrap coordination, and the invariant that Node-RED consumers keep boot identity until restart.
- [ ] **Step 2: Run the prose checker.** Run `node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md .claude/skills/osi-config-and-flags/SKILL.md CHANGELOG.md execution-report.md`. Resolve every tier-1 finding and review tier-2 warnings individually.
- [ ] **Step 3: Run shell/service, flows, and GUI gates fresh.** Record complete outputs and exit codes. Do not reuse earlier task evidence.
- [ ] **Step 4: Review the complete diff against PR A scope.** Confirm no EUI is exposed through `/api/system/stats`; no function node uses child process in the changed hunks; `sync-init-fn`, `/api/system/reboot`, and migration-preflight bodies are unchanged.
- [ ] **Step 5: Commit.** Use `docs: document live gateway identity transitions`.
- [ ] **Step 6: Request independent adversarial verification before opening PR A.** The verifier reruns all gates and reviews the state-machine interleavings.

### Task 8: Prove PR A on a disposable gateway

Use `192.168.8.180` only after the operator confirms it is still the disposable bench Pi. If it is not disposable or credentials are unavailable, stop and record the blocked live checks. Do not substitute a farm gateway.

- [ ] **Step 1: Take the runbook backup before deployment.** Back up `/data/db/farming.db` with SQLite `.backup`, sidecars, `/srv/node-red`, ChirpStack SQLite, and the GUI. Record the backup path and pre-deploy `device_data` count.
- [ ] **Step 2: Deploy with the hardened reverse-tunnel command.** Download `deploy.sh` before executing it; do not use `curl | sh`. Confirm the deploy installed and started identityd without replacing `farming.db`.
- [ ] **Step 3: Verify BusyBox reality on-device.** Run `now=$(date +%s); target=$((now + 60)); date -u -d "@$target" +%Y-%m-%dT%H:%M:%SZ`. Require exit 0 and a timestamp 60 s in the future.
- [ ] **Step 4: Establish a true provisional-running scenario.** On the disposable image, start Node-RED while concentratord is disabled and prove its process environment says `DEVICE_EUI_CONFIDENCE=provisional`. Then enable/start concentratord without restarting Node-RED.
- [ ] **Step 5: Observe the transition.** Within 10 s of concentratord answering, require UCI/cache to show authoritative, the sentinel to show a future deadline about 60 s away, `/api/system/stats` to expose only reason/deadline, and the browser banner to count down.
- [ ] **Step 6: Prove the gates stay closed during the window.** With an operator-provided local bearer token, `POST /api/account-link` must return the restart-pending 503 before any server request, and sync builders must record the gateway-identity restart pause. `GET /api/account-link/status` is not evidence for this gate.
- [ ] **Step 7: Observe automatic restart.** Record the Node-RED PID before transition and after the deadline. Require exactly one identity-owned PID change, sentinel removal, authoritative `DEVICE_EUI*` in the new process environment, the MQTT client ID/credential user matching that EUI, and the sync trigger SQL containing the same EUI.
- [ ] **Step 8: Prove the gates open after restart.** An authenticated link attempt must progress beyond the identity gate; authenticated sync state must report authoritative/non-pending identity. Do not reset credentials or contact `osicloud.ch` to obtain this proof.
- [ ] **Step 9: Measure steady-state daemon CPU.** If `getconf CLK_TCK` is unavailable, stop this measurement rather than assuming a tick rate. Otherwise run:

```sh
pid="$(ps w | awk '$0 ~ /[o]si-identityd\.sh start/ { print $1; exit }')"
[ -n "$pid" ] || exit 1
hz="$(getconf CLK_TCK)" || exit 1
before="$(awk '{ print $14 + $15 }' "/proc/$pid/stat")" || exit 1
sleep 60
after="$(awk '{ print $14 + $15 }' "/proc/$pid/stat")" || exit 1
awk -v delta="$((after - before))" -v hz="$hz" 'BEGIN { pct=(delta/hz/60)*100; printf "osi-identityd cpu_pct=%.4f\n", pct; exit !(pct < 0.1) }'
```

Require exit 0 and `cpu_pct` below 0.1.
- [ ] **Step 10: Run the live-ops post-deploy checklist.** Require preserved/increased `device_data` count, Node-RED `/gui` 301, fresh health rows, and expected ChirpStack profile variables.
- [ ] **Step 11: Add sanitized evidence to `execution-report.md`.** Do not include API keys, passwords, MQTT credentials, bearer tokens, or full `uci show osi-server` output.

## Slice 2: idempotent ChirpStack gateway registration

### Task 9: Add `ensureGateway` with direct generated-API tests

**Files:**

- Create: `scripts/test-chirpstack-ensure-gateway.js`
- Modify: both profile copies of `files/usr/share/node-red/osi-chirpstack-helper/index.js`

- [ ] **Step 1: Write failing Node tests against a fake `gatewayClient`.** Construct the existing client with a dummy local URL/API key, replace `gatewayClient.get/create`, and inspect the real generated protobuf request. Cover existing gateway, create, NOT_FOUND-then-ALREADY_EXISTS race, invalid/empty/all-01 EUI, empty tenant ID, and transport failure.
- [ ] **Step 2: Run `node --test scripts/test-chirpstack-ensure-gateway.js`.** Expected: failure because `ensureGateway` is absent.
- [ ] **Step 3: Add strict gateway-ID normalization.** Accept only 16 uppercase hexadecimal characters and reject `0101010101010101`. Confidence is not inferred from an EUI; callers own the provisional check.
- [ ] **Step 4: Implement `ensureGateway`.** Use the generated native Node API:

```js
const gateway = new gatewayPb.Gateway();
gateway.setGatewayId(gatewayId);
gateway.setName(name);
gateway.setTenantId(tenantId);
const request = new gatewayPb.CreateGatewayRequest();
request.setGateway(gateway);
await grpcInvoke(this.gatewayClient, 'create', request, this.metadata, 'ensureGateway');
```

Return `{created:false}` when `getGateway` succeeds or create races with `ALREADY_EXISTS`; return `{created:true}` after successful create. Propagate other errors with the existing annotations.
- [ ] **Step 5: Run the focused test, profile parity, helper registration verifier, and `git diff --check`.** Stop on red.
- [ ] **Step 6: Commit.** Use `feat: ensure ChirpStack gateway registration`.

### Task 10: Build a credential-safe registration command

**Files:**

- Create: `scripts/chirpstack-register-gateway.js`
- Create: `scripts/test-chirpstack-register-gateway.js`
- Create: both profile copies of `files/usr/share/node-red/chirpstack-register-gateway.js`
- Modify: `scripts/verify-profile-parity.js`
- Modify: `scripts/verify-live-gateway-identity.js`

- [ ] **Step 1: Write failing tests with dependency injection.** Cover provisional no-op, `phase=healing` no-op even with authoritative confidence, authoritative `phase=active` create, non-provisional `phase=restart_pending` create, existing gateway, missing/malformed env file, missing API key, named tenant selection, first gateway-capable tenant fallback, no capable tenant, and gRPC failure exit behavior. Assert logs never contain the API key.
- [ ] **Step 2: Run `node --test scripts/test-chirpstack-register-gateway.js`.** Expected: failure because the command is absent.
- [ ] **Step 3: Implement the env loader.** Read `CHIRPSTACK_API_URL` and `CHIRPSTACK_API_KEY` from `process.env` first, then parse `/srv/node-red/.chirpstack.env` per key using the same comment/blank-line behavior as `node-red.init`. Never print the key or the full env file.
- [ ] **Step 4: Implement identity validation.** Read the daemon cache, require phase `active` or `restart_pending`, a normalized 16-hex EUI, and confidence `authoritative` or `persisted`. Exit 0 without a gRPC call for `provisional` or `healing` state. Treat a missing/unknown phase as unsafe and exit 0 without registration; the daemon will rewrite the cache and retry.
- [ ] **Step 5: Select the tenant.** Convert list items with `chirpstack.listItemToObject`. Prefer `Open Smart Irrigation` when gateway-capable; otherwise use the first tenant whose `canHaveGateways` is not false. If none exists, exit non-zero so bootstrap can create one and identityd can retry.
- [ ] **Step 6: Call `ensureGateway`.** Use name `OSI Gateway <EUI>`. Export `main`, env parsing, identity parsing, and tenant selection for tests; invoke `main()` only under `require.main === module`.
- [ ] **Step 7: Keep all three repo copies byte-identical.** The three repository copies are `scripts/chirpstack-register-gateway.js` and the bcm2712/bcm2709 image files; `/srv/node-red/chirpstack-register-gateway.js` is a deploy target, not a fourth repository copy. The existing `files/usr/share/node-red` directory entry already gives profile-parity coverage; add an explicit verifier assertion that the scripts copy equals both image copies. Add a narrower parity entry only if the verifier is changed to require one, without duplicating coverage accidentally.
- [ ] **Step 8: Run focused tests, the shell/service gate, profile parity, and `git diff --check`.** Stop on red.
- [ ] **Step 9: Commit.** Use `feat: add ChirpStack gateway registration command`.

### Task 11: Reconcile registration independently of identity transitions

**Files:**

- Modify: both profile copies of `files/usr/libexec/osi-identityd.sh`
- Modify: `scripts/test-osi-identityd.sh`
- Modify: `deploy.sh`
- Modify: `scripts/verify-live-gateway-identity.js`

- [ ] **Step 1: Add failing daemon tests.** Require registration on the first `active` non-provisional tick even when no identity transition occurs; allow `restart_pending` after validated healing; suppress registration in `provisional` and `healing`; retry every 10 s after failure; suppress further calls after a success stamp containing the same EUI; clear/replace the stamp when EUI changes; and perform one idempotent check after each boot because `/var/run` is empty.
- [ ] **Step 2: Run the daemon test.** Expected: non-zero because no registration reconciliation exists.
- [ ] **Step 3: Add the independent reconciliation path.** It runs after identity resolution and transition handling, but calls the command only when the cache phase is `active` or `restart_pending` with non-provisional confidence. Invoke `/srv/node-red/chirpstack-register-gateway.js` when present, else `/usr/share/node-red/chirpstack-register-gateway.js`. Store only the successful EUI in `/var/run/osi-chirpstack-gateway-registered`. A failed or incomplete heal must never create the stamp or invoke gRPC.
- [ ] **Step 4: Rate-limit failure logs.** Retry at 10 s while unregistered, but log the first failure and then at most once per 300 s until success. Do not hide the command's non-zero status from daemon state tests.
- [ ] **Step 5: Extend `deploy.sh`.** Install the registration command under `/srv/node-red` after the helper, with mode 755. The image copy remains under `/usr/share/node-red`.
- [ ] **Step 6: Run the shell/service gate and the focused registration tests.** Stop on red.
- [ ] **Step 7: Commit.** Use `feat: reconcile ChirpStack gateway registration`.

### Task 12: Verify and ship PR B

- [ ] **Step 1: Run shell/service, flows, and GUI gates fresh.** Slice 2 should not change GUI/flows, but the complete gate proves the stacked branch remains healthy.
- [ ] **Step 2: Run registration twice on the disposable gateway.** Both invocations must exit 0; the first may create, the second must report existing. `SELECT hex(gateway_id), name FROM gateway` must show one row for the authoritative EUI.
- [ ] **Step 3: Prove stable-fleet repair.** Restart identityd without changing UCI/cache. It must reconcile the already-authoritative EUI, demonstrating registration is not tied to transition detection.
- [ ] **Step 4: Update `AGENTS.md`, the config skill, `CHANGELOG.md`, and `execution-report.md`.** Document credential source, tenant rule, retry/stamp behavior, and native `@grpc/grpc-js` API. Run the prose checker.
- [ ] **Step 5: Request independent verification and open PR B.** Do not merge on remembered PR A evidence.

## Slice 3: restart-sentinel reader deduplication in a separate PR

### Task 13: Extract only the restart-sentinel reader

**Files:**

- Create in both profiles: `files/usr/share/node-red/osi-gateway-identity-helper/index.js`
- Create in both profiles: `files/usr/share/node-red/osi-gateway-identity-helper/package.json`
- Create in both profiles: `files/usr/share/node-red/osi-gateway-identity-helper/index.test.js`
- Modify in both profiles: `files/usr/share/node-red/osi-lib/index.js`
- Modify in both profiles: `files/usr/share/node-red/osi-lib/index.test.js`
- Modify in both profiles: `files/usr/share/node-red/package.json`
- Modify in both profiles: `files/usr/share/node-red/package-lock.json`
- Modify: `deploy.sh`
- Modify via a throwaway roundtrip script: the seven Slice 1 nodes in both `flows.json` copies
- Modify: `scripts/verify-helper-registration.js` only if its generic discovery cannot cover the new package unchanged
- Modify: `scripts/verify-live-gateway-identity.js`

The helper exports only restart-state parsing and fail-closed policy. It does not contain current identity selection, sync state mutation, DB access, or migration preflight.

- [ ] **Step 1: Write failing helper tests.** Cover absent file -> false, valid state -> true, malformed existing file -> true plus warning, missing `fs` -> true plus warning, and custom path injection for tests.
- [ ] **Step 2: Implement `readRestartPending({fs,path,warn})`.** Keep it pure except for the injected file reader and warning callback.
- [ ] **Step 3: Register the helper through `osi-lib`.** Map `gateway-identity` to `osi-gateway-identity-helper`, add the file dependency and lock entry, and deploy package/index files. `verify-helper-registration.js` must pass without a special-case bypass.
- [ ] **Step 4: Repoint the seven nodes.** Declare `{"var":"osiLib","module":"osi-lib"}` in each node's `libs`, call `osiLib.require('gateway-identity')`, fail closed when loading fails, and remove the duplicated local reader. Use no bare `require()`.
- [ ] **Step 5: Assert prohibited code is untouched.** Hash every `runGatewayMigrationPreflight` body before mutation and compare afterward; assert `sync-init-fn` and `/api/system/reboot` nodes are byte-identical. No task in this slice may edit those functions.
- [ ] **Step 6: Run helper tests, `verify-helper-registration`, and the complete flows gate.** Node functions should shrink; remove consumed size allowances when the ratchet permits it.
- [ ] **Step 7: Commit on a new branch/PR.** Use `refactor: share gateway restart sentinel reader`.

### Task 14: Verify and ship PR C

- [ ] **Step 1: Run all local gates fresh and record exits.** Include helper registration and both helper test copies.
- [ ] **Step 2: Compare runtime behavior with PR B.** The independent verifier checks absent, valid, and corrupt sentinel behavior in every consumer and confirms identical HTTP/status outcomes.
- [ ] **Step 3: Run the prose checker on any updated documentation and `execution-report.md`.** Stop on tier-1 findings.
- [ ] **Step 4: Open PR C separately.** Its diff must contain no daemon state changes, registration changes, schema code, or migration-preflight edits.

## Final acceptance matrix

| Scenario | Required result |
|---|---|
| Fresh flash, Node-RED starts provisional, concentratord becomes ready | Detection within 10 s; heal succeeds; 60 s warning; one Node-RED restart; boot env, MQTT, trigger, link, and sync all use authoritative EUI afterward. |
| Linked override uses the same numeric provisional EUI | Confidence promotion still schedules heal/restart. |
| Concentrator EUI changes on a running linked gateway | Sentinel blocks link, bootstrap, outbox, pending pull, force sync, and ACK delivery until restart; post-restart migration preflight handles old rows. |
| Heal fails | No restart deadline and no active candidate; daemon retries; gates stay closed. |
| Concentratord disappears between detection and heal | A provisional final result creates no deadline; the healing sentinel remains and retries. |
| Daemon dies after persist but before deadline creation | The existing healing sentinel resumes validation and scheduling even though durable UCI already matches. |
| Daemon resumes after a restart deadline elapsed | It attempts the Node-RED restart on the next one-second control tick. |
| Node-RED restart fails | Sentinel remains, warning is rescheduled, and daemon retries. |
| No concentrator | Cache remains provisional; polling relaxes to 300 s after 10 min; no identity restart or registration log spam. |
| Bootstrap, account link, or account unlink finishes during identity transition | It requests the same coordinator; it cannot cause an early or duplicate restart. |
| Gateway was authoritative before Slice 2 | Registration reconciliation still runs and creates/reuses the ChirpStack gateway. |
| Registration temporarily fails | Identity activation is unaffected; registration retries independently without a new identity transition. |
| Identity cache is in `healing` | Registration performs no gRPC call and creates no success stamp. |
| Corrupt/missing tmpfs state | Missing sentinel preserves current boot behavior; existing corrupt sentinel fails closed and warns. |
| Work already passed its sentinel check | It may finish on the old boot identity; coupled identity surfaces still switch together at restart. |

No slice is complete until its local gates, independent verification, and applicable live checks have real output and exit codes in `execution-report.md`.
