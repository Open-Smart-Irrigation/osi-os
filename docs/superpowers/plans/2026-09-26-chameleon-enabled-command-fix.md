# Cloud Chameleon toggle fix (SET_CHAMELEON_CONFIG) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Review status (2026-09-27): NOT EXECUTABLE.** The command-name diagnosis is
> correct, but the proposed cloud path mutates the cloud `Device` mirror before
> the edge applies the command. That contradicts the edge-authoritative sync
> model and can return a false success for a command an old edge will drop. The
> binding corrections below supersede the affected Task 1 API/service sketches
> and rollout text. Rewrite those steps before implementation.

> **Status on osi-os main at `ca08dcc13` (2026-09-29): not implemented.**
> `cmd-type-registry` lists `SET_CHAMELEON_CONFIG` (`dispatch:
> 'chameleon_config'`), Route Command (`934bf2bc19a8ce22`) still has no branch
> for it, and no capability builder advertises `chameleon_config_commands_v1`.
> WATERMARK phase 1 is on main; its D7 check against `chameleon_enabled` is a
> phase 3 item and does not exist yet. The node sizes and line references below
> were measured on `c5bc18314` and must be measured again on the rewrite base.

> **Binding amendment:** the corrected cloud path uses `DesiredStateService`,
> whose current `validate` method rejects a null or blank `effectKey` for every
> mutation kind. `SET_CHAMELEON_CONFIG` therefore uses
> `chameleon_config:<EUI>:<base>` and binds that key to `device_eui` plus
> `base_sync_version` in the command contract and both ledgers. The old
> no-contract-change and pre-mutated-device sketches are investigation notes,
> not executable instructions.

**Goal:** Switching Chameleon on or off in the cloud GUI changes `devices.chameleon_enabled` on the gateway and comes back as an honest ACK, and a test in osi-server fails whenever the cloud names a command type the sync contract does not declare.

**Architecture:** The cloud queues capability-gated `SET_CHAMELEON_CONFIG`
through the desired-state ledger and leaves its DEVICE mirror unchanged until
the edge event returns. The command contract binds device EUI, base version,
and effect key. A dedicated edge applier performs an exact-base transaction and
durable replay. A server source-scan test still guards command names against the
vendored enum.

**Tech Stack:** osi-server: Java 17, Spring Boot, JUnit 5, Mockito, AssertJ, Gradle. osi-os: Node-RED `flows.json` function nodes, plain-Node verifier scripts, sqlite3 CLI.

**Spec:** This plan is its own spec. The owner's brief (2026-09-26): fix the cloud/edge `SET_CHAMELEON_ENABLED` mismatch in a separate small paired PR before WATERMARK phase 2, and add a test that every command type a cloud controller issues is in the contract enum. The investigation below records the findings the design rests on.

## Owner decisions

No new owner decision is required. The binding corrections below block
execution until the two tasks are rewritten. Two investigation follow-ups stay
out of scope; say whether to file them as issues:

1. **Admin route takes any command type.** `POST /api/v1/devices/{deviceEui}/gateway-command` (`DeviceController#sendGatewayCommand`, ADMIN only) passes `request.commandType()` straight to `CommandService`. A typo there queues a command the edge drops without an ACK. Proposed follow-up: validate against a server-side list of issuable types.
2. **`REPLACE_WEATHER_STATION_ZONES` is cloud-only.** osi-server issues it (`WeatherStationZoneMutationService`) and its vendored contract stages it, but the edge contract enum and Command Type Registry lack it, so Reject Indefinite Open would drop it. It is dormant today: the cloud only takes that path for gateways advertising `weather_station_zones_desired_state_v1`, and no edge on main advertises it. It becomes a live bug the day an edge advertises that capability without the registry entry.

## Binding review corrections

The fix keeps the command rename and edge applier, but changes the cloud state
transition and rollout boundary.

1. **The cloud mirror remains observational.** The controller must not call
   `DeviceService.setChameleonEnabled`, must not write
   `devices.chameleon_enabled`, and must not bump the cloud device
   `sync_version`. It validates access and queues `SET_CHAMELEON_CONFIG` through
   `DesiredStateService`. The HTTP response is `202` with the desired-state
   operation. Only a later edge DEVICE event changes the cloud mirror.
2. **The desired value and version binding are explicit.** The operation targets
   the edge DEVICE resource at its mirrored base version and desires
   `{ "chameleon_enabled": 0|1 }`. The command carries `base_sync_version` and
   `effect_key = chameleon_config:<uppercase-device-eui>:<base_sync_version>`.
   `DesiredStateService` requires the nonblank key before it issues a command.
   ACK means the edge accepted the write; APPLIED requires the mirrored DEVICE
   event to converge at a version greater than the base.
3. **Capability-gate the mixed fleet.** The edge advertises
   `chameleon_config_commands_v1` only in the release that contains the applier.
   The linked-account capability mirror, controller, and GUI require it before
   queueing or enabling the toggle. An old gateway therefore gets `501`/a
   disabled control instead of a command that will be leased and dropped five
   times.
4. **Cloud-first rollout is then safe and honest.** Deploying the cloud first
   disables the control until an upgraded edge reports the capability. Deploying
   the edge enables it on the next capability refresh. The old plan's statement
   that both orders were safe ignored user edits made during the mixed-version
   window.
5. **The contract and ledgers enforce the same binding.** Add the effect-key
   format to `docs/contracts/sync-schema/effect-keys.md`, require the key and
   base version in the `SET_CHAMELEON_CONFIG` schema branch, and add an
   `x-semantic-bindings` entry with
   `{prefix: "chameleon_config", uuid_path: "device_eui", version_path:
   "base_sync_version"}`. `uuid_path` is the existing metadata field name; the
   validator reads the identifier at that path and does not require it to be a
   UUID. Add the entry to both validators' exact expected maps. The edge
   parser rejects a key whose prefix, EUI, or version differs; its terminal
   command ledger stores the accepted key. The cloud desired-state row and
   `device_commands.effect_key` store that same value.
6. **The edge uses an exact-base compare-and-set.** The old generic SQL accepts
   `sync_version <= requested target`. That can overwrite an independent edge
   edit already at target `base + 1`. The corrected applier locks the device
   row, requires its current `sync_version` to equal `base_sync_version`, writes
   `base + 1`, and records the terminal command result in the same transaction.
   A replay returns that durable result without evaluating the now-stale base
   again. Any other current version returns `CONFLICT / stale_sync_version` and
   leaves the row untouched.
7. **Tests must pin the authority boundary.** The controller test asserts the
   repository mirror is unchanged after the request, the response is pending,
   and a simulated DEVICE event is the only action that changes the mirrored
   flag and completes the desired-state operation. Add capability-absent and
   stale-base cases, plus contract and edge-applier cases for a missing,
   mismatched-EUI, or mismatched-version effect key.
8. **Desired-state rewrite must preserve the binding.** The current
   `DesiredStateService.canRewrite` can reuse an unleased same-type command
   after the request's base and effect key changed, while
   `rewriteUnleasedGatewayCommand` rewrites the payload and target version but
   leaves `device_commands.effect_key` unchanged. The edge then ACKs the new
   payload key and the cloud rejects that ACK against the old persisted key.
   Before this command uses the ledger, restrict command reuse to requests with
   the same base version and the same effect key. A changed base/key issues a
   new command and supersedes the prior operation. Pin this in
   `DesiredStateServiceTest`; reclaimed leases remain non-rewritable because
   their lease timestamps are retained.

Task 2's edge routing and postcondition work remains useful, but its capability
builders and parity tests must be extended. Task 1 must be rewritten around the
desired-state ledger and the capability mirror. The source-scan contract guard
remains in scope.

### Exact rewrite checklist

Before either implementation task becomes executable:

- replace Task 1's `DeviceService.setChameleonEnabled` call, `200` response,
  and mutated `Device` assertions with a target resolver, a
  `DesiredStateService.Request`, and a `202` pending response;
- use the mirrored DEVICE `sync_version` as `baseSyncVersion`; include
  `base_sync_version` and `chameleon_config:<EUI>:<base>` in the command payload
  and request, with `desired = {chameleon_enabled: 0|1}`;
- add `chameleon_config_commands_v1` to all three edge capability builders,
  its edge parity tests, the linked-account mirror, the controller gate, and
  both GUI states;
- amend `commands.schema.json`, `effect-keys.md`, contract golden/staging data,
  semantic-binding verification, and the server's vendored contract surfaces;
- add the desired-state rewrite regression first: same type but changed
  base/effect key must issue a new command, while the existing same-binding
  unleased rewrite case remains valid;
- replace Task 2's `appliedSyncVersion`-only parser with a base-version and
  effect-key-bound exact-base compare-and-set that records one terminal result
  atomically and returns the same result on replay; delete the generic
  `sync_version <= target` route for this command;
- test current version = base (apply), current version = base + 1 from an
  unrelated edge edit (conflict, no overwrite), and redelivery of the original
  command after its committed ACK was lost (same stored result, no second
  write);
- replace every "no contract change" and "both deploy orders are safe" PR or
  rollout statement with the cloud-first, capability-gated sequence;
- rerun the cross-repo contract gates and backend tests named by the rewritten
  tasks before removing the NOT EXECUTABLE banner.

> **STOP: retained sketches below are non-executable.** They still call
> `DeviceService.setChameleonEnabled`, return a mutated cloud mirror, omit the
> required effect key, and use the unsafe generic version predicate. They are
> investigation evidence only until Tasks 1 and 2 are replaced from the
> checklist above.

## Investigation findings

**Root cause.** `DeviceController#setChameleonEnabled` (osi-server `backend/src/main/java/org/osi/server/device/DeviceController.java:296`) queues `SET_CHAMELEON_ENABLED`. That type is in neither contract enum (`docs/contracts/sync-schema/commands.schema.json` here, `backend/src/test/resources/sync-contract/commands.schema.json` in osi-server) nor the edge's Command Type Registry (`cmd-type-registry`). Reject Indefinite Open (`reject-indefinite-open`) drops it with `node.warn({ rejected: 'unknown_command_type' })` and sends no ACK.

**The edge never applied `SET_CHAMELEON_CONFIG` either.** It is in the registry (`dispatch: 'chameleon_config'`, a field no node reads for routing) and passes Reject Indefinite Open, but Route Command (`934bf2bc19a8ce22`) has no case for it and falls through to `return null`. Renaming the cloud literal alone would change nothing on a gateway.

**What happens to a dropped command.** The edge polls with `X-OSI-Sync-Protocol: 2`, so every poll leases the command for 300 s (`CommandLeaseService`). With no ACK, `reclaimExpiredLeases` returns it to PENDING and counts an attempt; the fifth expiry sets `NACKED` / `max_attempts_exceeded`. A queued `SET_CHAMELEON_ENABLED` on a polling gateway is terminal within about 25 minutes. On a gateway that is offline it stays PENDING until the gateway polls again, then takes the same five-lease path. `CommandRetentionJob`'s stale-pending expiry covers `SET_CHAMELEON_CONFIG` and `SET_SDI12_IDENTIFY` only, which becomes correct once the cloud issues the contract type.

**Payload.** The cloud already sends `{ deviceEui, gatewayDeviceEui, chameleonEnabled (boolean), syncVersion }` with `aggregateType: "DEVICE"`, `aggregateKey: <device EUI>`, `appliedSyncVersion: device.syncVersion` after `DeviceService#setChameleonEnabled` bumped it. Replay Pending Commands (`sync-pending-split`) merges the payload with `commandId`, `commandType` and `appliedSyncVersion` into one flat object, which is what Route Command and Build UPDATE SQL read. The edge's local route (`put-chameleon-enabled-auth-fn`) writes `chameleon_enabled` only for `type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL` rows; the cloud refuses non-LSN50 devices in `DeviceService#setChameleonEnabled`.

**Contract files do not change.** `SET_CHAMELEON_CONFIG` is already in both enums and in `sync-contract-golden.json` `commandTypes.cloudIssuerEnabled`. `scripts/verify-sync-contract.js` requires the edge enum to equal registry + routed + staged, which stays true. osi-server's `commands.schema.json` is deliberately not byte-mirrored (`scripts/verify-edge-sync-contract-vendor.sh` excludes it), so there is no mirror-byte check to run for this change.

## Decision

Cloud switches to `SET_CHAMELEON_CONFIG` with its existing payload; the edge implements the applier. No `SET_CHAMELEON_ENABLED` alias on the edge.

- **Why not an edge alias.** It would add an undeclared type to the edge registry, which `verify-sync-contract.js` then forces into the contract enum on both sides, permanently, to rescue commands that are already NACKED on every polling gateway. The only rows it could still reach are PENDING ones for offline gateways, where applying a days-old toggle is of doubtful value; the edge's own `DEVICE_FLAGS_UPDATED` event re-converges the cloud to the gateway's value anyway.
- **Why not fold it into `UPSERT_DEVICE_FLAGS`.** Every dendro/temp/rain/flow toggle would then also rewrite `chameleon_enabled` from the cloud's copy, which widens the blast radius of those four routes for no gain.
- **No transition shim, no data migration.** Leftover `SET_CHAMELEON_ENABLED` rows die by the five-lease NACK above; they cost five `unknown_command_type` warnings per row on the gateway log.
- **Deploy order.** Cloud first is the project rule, and both orders are safe. Cloud before edge: an old edge accepts `SET_CHAMELEON_CONFIG` through the registry, Route Command drops it, and it NACKs after five leases, exactly today's outcome. Edge before cloud: the new applier is idle until the cloud sends the type. The toggle works once both are deployed.

**Edge semantics chosen.** The write is guarded (`COALESCE(sync_version, 0) <= requested`) and the ACK goes through the postcondition-verified path, the way REMOVE_DEVICE_FROM_ZONE works, instead of the unguarded direct path UPSERT_DEVICE_FLAGS uses. The toggle this PR fixes failed silently, so the fix should not ACK SUCCESS for a device the gateway does not have. Outcomes:

| Edge state | ACK |
|---|---|
| LSN50 row present, `sync_version <= requested` | SUCCESS / APPLIED, row holds the flag at the requested version |
| Same command redelivered | SUCCESS (idempotent) |
| Row newer than the command, flag differs | REJECTED_PERMANENT `stale_sync_version`, row untouched |
| No such device, or not a live `DRAGINO_LSN50` | FAILED_RETRYABLE `postcondition_not_met` (cloud NACKs after five) |
| Malformed payload (bad EUI, non-boolean flag, version < 1) | FAILED `Invalid SET_CHAMELEON_CONFIG payload`, direct ACK path |

## Global constraints

- osi-os worktree: `<osi-os-worktree>`, branch `feat/chameleon-enabled-cmd-fix` from origin/main `c5bc18314`.
- osi-server worktree: `<osi-server-worktree>`, branch `feat/chameleon-enabled-cmd-fix` from origin/main `cce3e8b6`.
- Never push, merge, deploy, or touch a gateway, server or remote host. The orchestrator pushes and opens PRs.
- No frontend builds (the workstation OOMs). Backend: run only the targeted `./gradlew test --tests ...` invocations below, one Gradle process at a time.
- Never bare `git stash`. The login shell is fish: wrap multi-part shell commands in `bash -c '...'`.
- `flows.json` is edited only by the one-shot script in Task 2 (never by hand or a text-replace tool), and both profiles (bcm2712 canonical, bcm2709 mirror) change together, byte-identical.
- No change to any contract file: `docs/contracts/sync-schema/*` (osi-os) and `backend/src/test/resources/sync-contract/*` (osi-server).
- Scratch scripts go in the session scratchpad, never in the repo.

## Review focus

1. **Sync-version comparison across the two sides.** The cloud sends `appliedSyncVersion = device.syncVersion + 1` from its mirror; the edge guard is `<=`. If the cloud mirror lags the edge by more than one, a legitimate toggle is REJECTED_PERMANENT `stale_sync_version` instead of applied. Pinned by the stale case in Task 2 (edge side); the lag itself is a property of the sync design, not of this change, and matches REMOVE_DEVICE_FROM_ZONE.
2. **String and numeric forms of the flag.** The local route accepts `true/false/1/0/'true'/'false'/'1'/'0'`; the command path must accept the same and reject anything else as FAILED, not silently write 0. Pinned by the `'true'` case and the `'maybe'` case in Task 2.
3. **A build-time FAILED must not be relabelled by verification.** Before this change no verified type could FAIL at build time; the router now sends a FAILED verified type down the direct ACK path. Pinned by the malformed-payload loop in Task 2.
4. **Non-LSN50 or deleted device rows are never written.** Pinned by the KIWI case in Task 2.
5. **The source-scan guard stays honest.** It must see real issued types, flag a planted undeclared one, ignore comment lines, and not let its allowlist rot. Pinned by the four tests in Task 1.

## File structure

| Repo | File | Change |
|---|---|---|
| osi-server | `backend/src/main/java/org/osi/server/device/DeviceController.java` | line 296: `SET_CHAMELEON_ENABLED` becomes `SET_CHAMELEON_CONFIG` |
| osi-server | `backend/src/test/java/org/osi/server/command/CloudIssuedCommandTypesContractTest.java` | new: controller-vs-contract source scan |
| osi-server | `backend/src/test/java/org/osi/server/device/DeviceControllerTest.java` | the Chameleon test verifies the type and payload (it only stubbed before) |
| osi-os | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` + bcm2709 mirror | five existing function nodes (Route Command, Build UPDATE SQL, the three postcondition nodes) |
| osi-os | `scripts/verify-command-ack-postconditions.js` | Chameleon cases; devices fixture gains `type_id`, `chameleon_enabled`, `deleted_at` |
| osi-os | `scripts/verify-flows-size-ratchet-allowances.json` | exact per-node growth for the five nodes |
| osi-os | `docs/superpowers/plans/2026-09-26-chameleon-enabled-command-fix.md` | this plan (already committed) |

---

### Task 1: osi-server issues SET_CHAMELEON_CONFIG, guarded by a controller-vs-contract scan

**Files:**
- Create: `backend/src/test/java/org/osi/server/command/CloudIssuedCommandTypesContractTest.java`
- Modify: `backend/src/test/java/org/osi/server/device/DeviceControllerTest.java` (method `setChameleonEnabled_queuesGatewayCommandForOwnedEdgeBackedDevice`, the last method in the class, about lines 2901-2939)
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java:296`

**Interfaces:**
- Consumes: the vendored contract on the test classpath, `sync-contract/commands.schema.json` (`/properties/command_type/enum`) and `sync-contract/events.schema.json` (`/properties/op/enum`), the same resources `SyncOpCoverageTest` reads.
- Produces: the queued command `SET_CHAMELEON_CONFIG` with payload keys `deviceEui` (16-hex string), `gatewayDeviceEui`, `chameleonEnabled` (boolean), `syncVersion` (long), aggregate `DEVICE` / device EUI, `appliedSyncVersion` = the bumped device sync version. Task 2's edge applier reads exactly these.

How the scan enumerates issued types: a source scan, not a call-site parser. Command types reach `CommandService` through at least seven call shapes (`issueGatewayCommand` in two overloads, `issueGatewayCommandRecord`, `persistGatewayCommand`, `DesiredStateService.Request`, `ValveCommandController#issue`, the force-sync replay of stored types), and every one of them starts as a string literal in `src/main/java`. The test takes the verbs the contract's own command types begin with (`SET`, `UPSERT`, `OPEN`, `CLOSE`, `DELETE`, `REPLACE`, ...), collects every double-quoted SCREAMING_SNAKE literal on a non-comment line that starts with one of them, and requires each to be a contract command type, a contract event op, or one of eight named non-command literals (`OPEN`, `DELETE`, `FORCE_SYNC`, four `VALVE_*` aggregate types, `WORK_REQUEST`). On the base commit exactly one literal fails: `SET_CHAMELEON_ENABLED` at `DeviceController.java:296`. Blind spots, stated in the class Javadoc: concatenated types (none today), a verb no contract type uses, and the admin route's request-body type (owner decision 1).

- [ ] **Step 1: Write the scan test**

Create `backend/src/test/java/org/osi/server/command/CloudIssuedCommandTypesContractTest.java`:

```java
package org.osi.server.command;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Every command type the cloud can queue for a gateway must be one the sync contract declares.
 *
 * <p>{@code SyncOpCoverageTest} guards the edge-to-cloud direction (every accepted event op
 * reaches an applier), and osi-os's {@code scripts/verify-sync-op-parity.js} compares edge
 * producers with this repo's event dispatch. Nothing guarded the cloud-to-edge direction:
 * {@code DeviceController#setChameleonEnabled} queued {@code SET_CHAMELEON_ENABLED}, a type
 * the contract never listed and the edge's command registry never knew. The edge dropped
 * every one of those commands as an unknown type without an ACK, the lease expired five
 * times, and the command ended NACKED -- so switching Chameleon on or off from the cloud
 * never reached the gateway, and nothing failed at compile, test or deploy time.
 *
 * <p>Why a source scan rather than a behavioural test: command types are issued from many
 * call shapes (the {@link CommandService} overloads, the desired-state ledger's
 * {@code Request}, controller-local {@code issue(...)} helpers, replay of stored types), so
 * no single mock sees them all. Every one of them starts life as a string literal in
 * {@code src/main/java}. This reads every literal that begins with a verb the contract's own
 * command types use ({@code SET_}, {@code UPSERT_}, {@code OPEN_} ...) and requires it to be
 * a declared command type, a declared event op, or one of the few named non-command
 * literals below.
 *
 * <p>Blind spots, on purpose: a type assembled by string concatenation (none exists today),
 * a type whose verb no contract type uses, and the admin-only
 * {@code POST /api/v1/devices/{deviceEui}/gateway-command} route, whose type comes from the request body.
 */
class CloudIssuedCommandTypesContractTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path MAIN_SOURCES = Path.of("src/main/java");
    private static final Pattern SCREAMING_SNAKE_LITERAL =
            Pattern.compile("\"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\"");

    /**
     * Literals that start with a command verb but are not command types. Each entry says what
     * it is. A new entry is a reviewed decision; a misspelt or renamed command type does not
     * belong here -- it belongs in the contract, on both sides, or nowhere.
     */
    private static final Map<String, String> NOT_COMMAND_TYPES = Map.of(
            "OPEN", "a valve action value and a dead-letter status; a bare OPEN command is refused by the edge",
            "DELETE", "an HTTP method in the CORS and rate-limit configuration",
            "FORCE_SYNC", "the trigger label inside FORCE_EDGE_SYNC and SYNC_LINKED_AUTH payloads",
            "VALVE_ACTUATION", "a sync aggregate type",
            "VALVE_RUNTIME", "a sync aggregate type",
            "VALVE_SCHEDULE", "a sync aggregate type",
            "VALVE_SETTINGS", "a sync aggregate type",
            "WORK_REQUEST", "a sync aggregate type");

    record Occurrence(String location, String literal) {
    }

    @Test
    void everyCommandShapedLiteralInTheCloudIsDeclaredByTheContract() throws IOException {
        Set<String> commandTypes = contractCommandTypes();
        Set<String> eventOps = contractEventOps();
        List<Occurrence> undeclared = new ArrayList<>();
        for (Occurrence occurrence : scanMainSources(commandVerbs(commandTypes))) {
            if (!isAccounted(occurrence.literal(), commandTypes, eventOps)) {
                undeclared.add(occurrence);
            }
        }

        assertThat(undeclared)
                .as("""
                        Command-shaped string literals in src/main/java that the vendored sync \
                        contract (sync-contract/commands.schema.json) does not declare. If the \
                        cloud queues one of these for a gateway, the edge drops it as an unknown \
                        type and the command is NACKED after five leases without ever applying. \
                        Use the contract's command type, or add the type to the contract in \
                        osi-os first (registry + applier + commands.schema.json), then vendor it \
                        here. If the literal is not a command type at all, add it to \
                        NOT_COMMAND_TYPES with the reason.""")
                .isEmpty();
    }

    /** The scan is worthless if it cannot see the command types the cloud does issue. */
    @Test
    void theScanSeesTheCommandTypesTheCloudIssues() throws IOException {
        Set<String> seen = new TreeSet<>();
        scanMainSources(commandVerbs(contractCommandTypes())).forEach(o -> seen.add(o.literal()));

        assertThat(seen).contains(
                "UPSERT_DEVICE_FLAGS",
                "SET_LSN50_MODE",
                "OPEN_FOR_DURATION",
                "SET_CHAMELEON_CONFIG");
    }

    /** The rule itself, on the exact line that shipped the bug. */
    @Test
    void theScanRejectsACommandTypeTheContractDoesNotDeclare() throws IOException {
        Set<String> commandTypes = contractCommandTypes();
        Set<String> eventOps = contractEventOps();
        List<String> source = List.of(
                "        commandService.issueGatewayCommand(gateway, \"SET_CHAMELEON_ENABLED\", payload, user, \"DEVICE\",",
                "        // \"SET_SOMETHING_IN_A_COMMENT\" is not code",
                "        commandService.issueGatewayCommand(gateway, \"SET_CHAMELEON_CONFIG\", payload, user, \"DEVICE\",");

        List<String> undeclared = scanLines("Example.java", source, commandVerbs(commandTypes)).stream()
                .map(Occurrence::literal)
                .filter(literal -> !isAccounted(literal, commandTypes, eventOps))
                .toList();

        assertThat(undeclared).containsExactly("SET_CHAMELEON_ENABLED");
    }

    /** An allowlist entry that the contract now declares, or that no source uses, has rotted. */
    @Test
    void everyNonCommandLiteralIsStillUsedAndStillNotACommandType() throws IOException {
        Set<String> commandTypes = contractCommandTypes();
        Set<String> seen = new TreeSet<>();
        scanMainSources(commandVerbs(commandTypes)).forEach(o -> seen.add(o.literal()));

        assertThat(NOT_COMMAND_TYPES.keySet())
                .as("NOT_COMMAND_TYPES entries must not be contract command types")
                .doesNotContainAnyElementsOf(commandTypes);
        assertThat(seen)
                .as("every NOT_COMMAND_TYPES entry should still occur in src/main/java; remove stale ones")
                .containsAll(NOT_COMMAND_TYPES.keySet());
    }

    // --- scanning ------------------------------------------------------------------

    private static boolean isAccounted(String literal, Set<String> commandTypes, Set<String> eventOps) {
        return commandTypes.contains(literal)
                || eventOps.contains(literal)
                || NOT_COMMAND_TYPES.containsKey(literal);
    }

    private static List<Occurrence> scanMainSources(Set<String> verbs) throws IOException {
        List<Occurrence> found = new ArrayList<>();
        try (Stream<Path> sources = Files.walk(MAIN_SOURCES)) {
            for (Path source : sources.filter(path -> path.toString().endsWith(".java")).sorted().toList()) {
                found.addAll(scanLines(MAIN_SOURCES.relativize(source).toString(),
                        Files.readAllLines(source), verbs));
            }
        }
        assertThat(found).as("scan of %s found nothing -- wrong working directory?", MAIN_SOURCES)
                .isNotEmpty();
        return found;
    }

    private static List<Occurrence> scanLines(String file, List<String> lines, Set<String> verbs) {
        List<Occurrence> found = new ArrayList<>();
        for (int index = 0; index < lines.size(); index++) {
            String line = lines.get(index);
            if (!isCode(line)) {
                continue;
            }
            Matcher literal = SCREAMING_SNAKE_LITERAL.matcher(line);
            while (literal.find()) {
                String value = literal.group(1);
                if (verbs.contains(value.split("_", 2)[0])) {
                    found.add(new Occurrence(file + ":" + (index + 1), value));
                }
            }
        }
        return found;
    }

    private static boolean isCode(String line) {
        String trimmed = line.trim();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    }

    // --- contract reading ----------------------------------------------------------

    /** The verbs the contract's command types start with: SET, UPSERT, OPEN, CLOSE, ... */
    private static Set<String> commandVerbs(Set<String> commandTypes) {
        Set<String> verbs = new TreeSet<>();
        commandTypes.forEach(type -> verbs.add(type.split("_", 2)[0]));
        return verbs;
    }

    private static Set<String> contractCommandTypes() throws IOException {
        Set<String> types = new TreeSet<>();
        readJson("sync-contract/commands.schema.json")
                .at("/properties/command_type/enum")
                .forEach(node -> types.add(node.asText()));
        assertThat(types).as("vendored command_type enum should be populated").isNotEmpty();
        return types;
    }

    private static Set<String> contractEventOps() throws IOException {
        Set<String> ops = new TreeSet<>();
        readJson("sync-contract/events.schema.json").at("/properties/op/enum").forEach(node -> ops.add(node.asText()));
        return ops;
    }

    private static JsonNode readJson(String resource) throws IOException {
        try (InputStream stream = CloudIssuedCommandTypesContractTest.class.getClassLoader()
                .getResourceAsStream(resource)) {
            assertThat(stream).as("vendored contract resource %s", resource).isNotNull();
            return MAPPER.readTree(stream);
        }
    }
}
```

- [ ] **Step 2: Make the controller test verify the type and payload**

The current test stubs `issueGatewayCommand(..., eq("SET_CHAMELEON_ENABLED"), ...)` and never verifies, so it proves nothing about what is queued. Replace the whole method `setChameleonEnabled_queuesGatewayCommandForOwnedEdgeBackedDevice` (from its `@Test` line through its closing brace, just before the class's final `}`) with:

```java
    @Test
    void setChameleonEnabled_queuesTheContractsSetChameleonConfigCommand() {
        assertChameleonToggleQueuesSetChameleonConfig(true);
    }

    @Test
    void setChameleonDisabled_queuesTheContractsSetChameleonConfigCommand() {
        assertChameleonToggleQueuesSetChameleonConfig(false);
    }

    /**
     * The edge applies SET_CHAMELEON_CONFIG (osi-os Route Command -> Build UPDATE SQL) and reads
     * deviceEui, chameleonEnabled and the applied sync version. SET_CHAMELEON_ENABLED, which this
     * route used to queue, is in neither the contract nor the edge registry, so the edge dropped it.
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private void assertChameleonToggleQueuesSetChameleonConfig(boolean enabled) {
        User actor = User.builder().id(7L).username("alice").build();
        Device gateway = Device.builder().deviceEui("GW-1234").type("GATEWAY").claimedBy(actor).build();
        Device device = Device.builder()
                .id(45L)
                .deviceEui("AABBCCDDEEFF0011")
                .type("DRAGINO_LSN50")
                .claimedBy(actor)
                .syncVersion(2L)
                .gatewayDeviceEui("GW-1234")
                .build();
        UserDetails principal = new org.springframework.security.core.userdetails.User(
                "alice", "n/a", List.of(new SimpleGrantedAuthority("ROLE_USER")));

        when(userService.findByUsername("alice")).thenReturn(actor);
        when(deviceService.setChameleonEnabled("AABBCCDDEEFF0011", 7L, enabled)).thenReturn(device);
        when(deviceService.findAll()).thenReturn(List.of(gateway, device));
        when(deviceResponseMapper.toResponse(device)).thenReturn(DeviceController.DeviceResponse.from(device));

        var response = controller.setChameleonEnabled(
                "AABBCCDDEEFF0011",
                new DeviceController.SensorFlagRequest(enabled),
                principal);

        ArgumentCaptor<Map<String, Object>> payload = ArgumentCaptor.forClass((Class) Map.class);
        verify(commandService).issueGatewayCommand(
                org.mockito.ArgumentMatchers.eq(gateway),
                org.mockito.ArgumentMatchers.eq("SET_CHAMELEON_CONFIG"),
                payload.capture(),
                org.mockito.ArgumentMatchers.eq(actor),
                org.mockito.ArgumentMatchers.eq("DEVICE"),
                org.mockito.ArgumentMatchers.eq("AABBCCDDEEFF0011"),
                org.mockito.ArgumentMatchers.eq(2L),
                org.mockito.ArgumentMatchers.anyString());
        assertThat(payload.getValue()).containsExactlyInAnyOrderEntriesOf(Map.of(
                "deviceEui", "AABBCCDDEEFF0011",
                "gatewayDeviceEui", "GW-1234",
                "chameleonEnabled", enabled,
                "syncVersion", 2L));
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody().deviceEui()).isEqualTo("AABBCCDDEEFF0011");
    }
```

`ArgumentCaptor`, `Map`, `List`, `verify`, `when` and `assertThat` are already imported in this class; `forClass((Class) Map.class)` is the idiom it uses at line 1573.

- [ ] **Step 3: Run both tests and watch them fail for the right reason**

Run: `bash -c 'cd <osi-server-worktree>/backend && ./gradlew test --tests "org.osi.server.command.CloudIssuedCommandTypesContractTest" --tests "org.osi.server.device.DeviceControllerTest"'`

Expected: FAIL. In `CloudIssuedCommandTypesContractTest`, `everyCommandShapedLiteralInTheCloudIsDeclaredByTheContract` fails with `Expecting empty but was: [Occurrence[location=org/osi/server/device/DeviceController.java:296, literal=SET_CHAMELEON_ENABLED]]`, and `theScanSeesTheCommandTypesTheCloudIssues` fails because `SET_CHAMELEON_CONFIG` is not found; the other two pass. In `DeviceControllerTest`, both new Chameleon tests fail on `verify` with `Argument(s) are different!` (wanted `SET_CHAMELEON_CONFIG`, invoked `SET_CHAMELEON_ENABLED`). Every other `DeviceControllerTest` test passes. (Pre-validated while writing this plan: the scan test compiled with javac against the Gradle-cached jars and run from `backend/` gave exactly these two failures before the fix and 4/4 after.)

- [ ] **Step 4: Fix the controller**

In `backend/src/main/java/org/osi/server/device/DeviceController.java`, method `setChameleonEnabled`, change only the command type:

```java
            commandService.issueGatewayCommand(gateway, "SET_CHAMELEON_CONFIG", payload, user, "DEVICE",
                    device.getDeviceEui(), device.getSyncVersion(), UUID.randomUUID().toString());
```

Leave the payload map (`deviceEui`, `gatewayDeviceEui`, `chameleonEnabled`, `syncVersion`) as it is; the edge applier in Task 2 reads those keys.

- [ ] **Step 5: Run the tests to green, plus the neighbouring contract guards**

Run: `bash -c 'cd <osi-server-worktree>/backend && ./gradlew test --tests "org.osi.server.command.CloudIssuedCommandTypesContractTest" --tests "org.osi.server.device.DeviceControllerTest" --tests "org.osi.server.sync.SyncOpCoverageTest" --tests "org.osi.server.sync.SyncContractVendorTest"'`

Expected: BUILD SUCCESSFUL, all tests in those four classes pass.

- [ ] **Step 6: Confirm no contract file changed and nothing else references the old type**

Run: `bash -c 'cd <osi-server-worktree> && git status --short && grep -rn "SET_CHAMELEON_ENABLED" backend frontend --include=*.java --include=*.ts --include=*.tsx --include=*.json | grep -v "/node_modules/"'`

Expected: `git status` lists exactly the three files of this task. The grep prints only the lines inside `CloudIssuedCommandTypesContractTest.java` (the Javadoc and the planted line in `theScanRejectsACommandTypeTheContractDoesNotDeclare`) and the Javadoc in `DeviceControllerTest.java`.

- [ ] **Step 7: Commit**

```bash
bash -c 'cd <osi-server-worktree> && git add backend/src/main/java/org/osi/server/device/DeviceController.java backend/src/test/java/org/osi/server/command/CloudIssuedCommandTypesContractTest.java backend/src/test/java/org/osi/server/device/DeviceControllerTest.java && git commit -m "fix(device): queue SET_CHAMELEON_CONFIG for the Chameleon toggle

The Chameleon toggle queued SET_CHAMELEON_ENABLED, a type neither the
sync contract nor the edge registry declares. The edge dropped it as an
unknown type without an ACK and the command NACKed after five leases,
so the toggle never reached a gateway. Queue the contract type with the
same payload; the paired osi-os change applies it on the edge.

CloudIssuedCommandTypesContractTest scans src/main/java for command-shaped
literals and requires each to be a declared command type, an event op or
a named non-command literal, closing the cloud-to-edge gap that
SyncOpCoverageTest and verify-sync-op-parity do not cover."'
```

---

### Task 2: osi-os applies SET_CHAMELEON_CONFIG through the verified device-row path

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` and `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (nodes `934bf2bc19a8ce22` Route Command, `4f4a765f36cee6f3` Build UPDATE SQL, `command-postcondition-route`, `command-postcondition-build`, `command-postcondition-ack`)
- Modify: `scripts/verify-command-ack-postconditions.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces:**
- Consumes: Task 1's command. After Replay Pending Commands the flat message is `{ commandId, commandType: 'SET_CHAMELEON_CONFIG', eventUuid, aggregateType: 'DEVICE', aggregateKey, appliedSyncVersion, deviceEui, gatewayDeviceEui, chameleonEnabled, syncVersion, ... }`. Journal and Scoped Access apply nodes pass it through unchanged (`return [msg, null]` for types they do not own).
- Produces: `devices.chameleon_enabled` and `devices.sync_version` updated on live `DRAGINO_LSN50` rows; a `command_ack` with the outcomes in the Decision table. The existing `trg_sync_devices_outbox_au` trigger (migration 0016) then emits `DEVICE_FLAGS_UPDATED` with `chameleon_enabled`, which the cloud already applies.

Size ratchet: `verify-flows-size-ratchet.js` fails any existing node that grows past its allowance. Measured while writing this plan: Route Command +28, Build UPDATE SQL +981, `command-postcondition-route` +64, `command-postcondition-build` +233, `command-postcondition-ack` +177, total +1483 per profile. The two older entries for Route Command (706) and Build UPDATE SQL (731) describe growth origin/main already contains, so the script in Step 5 supersedes them with the exact new deltas instead of spending the stale headroom. `total_allowance` stays at the 71275 origin/main carries: `scripts/verify-live-gateway-identity.js` pins that number and its provenance words, and the +1483 fits inside it.

- [ ] **Step 1: Write the failing edge test**

Save this as `chameleon-cases.js.txt` in your scratchpad (it is spliced into the verifier in the next step):

```js
// SET_CHAMELEON_CONFIG (cloud "Chameleon on/off" toggle). Until this fix the cloud sent
// SET_CHAMELEON_ENABLED, which the edge dropped as an unknown type, and nothing on the
// edge applied SET_CHAMELEON_CONFIG either: Route Command had no case for it. These
// cases pin the whole local path: route -> Build UPDATE SQL -> apply -> verify -> ACK.
const CHAMELEON_EUI = 'A84041000181C2A0';
const KIWI_EUI = 'A84041000181C2A1';

function chameleonRow(db, deveui) {
  return rows(db, `SELECT chameleon_enabled, sync_version FROM devices WHERE deveui='${deveui}'`)[0];
}

async function runChameleonCases() {
  const temporary = makeDb();
  const db = temporary.db;
  try {
    sql(db, `INSERT INTO devices (deveui, type_id, chameleon_enabled, sync_version) VALUES
      ('${CHAMELEON_EUI}', 'DRAGINO_LSN50', 0, 3),
      ('${KIWI_EUI}', 'KIWI_SENSOR', 0, 3);`);

    // The shape the cloud sends (osi-server DeviceController#setChameleonEnabled),
    // after Replay Pending Commands merges the envelope into the payload.
    const enable = command('SET_CHAMELEON_CONFIG', {
      deviceEui: CHAMELEON_EUI, gatewayDeviceEui: 'AABBCCDDEEFF0011', chameleonEnabled: true, syncVersion: 4
    });

    const routed = runFunction(node(ROUTE_COMMAND), { payload: enable });
    assert(Array.isArray(routed), 'Route Command must return its output array for SET_CHAMELEON_CONFIG');
    const takenOutputs = [];
    routed.forEach((out, index) => { if (out) takenOutputs.push(index); });
    assert.deepStrictEqual(takenOutputs, [1], 'Route Command must send SET_CHAMELEON_CONFIG to output 2 (Build UPDATE SQL) only');
    assert.strictEqual(routed[1].payload.commandType, 'SET_CHAMELEON_CONFIG');

    const enabled = applyAndVerify(db, enable);
    expectSuccess(enabled, { commandId: enable.commandId, commandType: 'SET_CHAMELEON_CONFIG' });
    assert.deepStrictEqual(chameleonRow(db, CHAMELEON_EUI), { chameleon_enabled: 1, sync_version: 4 });

    // A redelivered command is idempotent.
    expectSuccess(applyAndVerify(db, enable), { commandId: enable.commandId });
    assert.deepStrictEqual(chameleonRow(db, CHAMELEON_EUI), { chameleon_enabled: 1, sync_version: 4 });

    const disable = command('SET_CHAMELEON_CONFIG', { deviceEui: CHAMELEON_EUI, chameleonEnabled: false, appliedSyncVersion: 5 });
    expectSuccess(applyAndVerify(db, disable), { commandId: disable.commandId });
    assert.deepStrictEqual(chameleonRow(db, CHAMELEON_EUI), { chameleon_enabled: 0, sync_version: 5 });

    // The edge is authoritative: a newer local change is not overwritten by an older cloud command.
    sql(db, `UPDATE devices SET chameleon_enabled = 0, sync_version = 9 WHERE deveui='${CHAMELEON_EUI}';`);
    const stale = applyAndVerify(db, command('SET_CHAMELEON_CONFIG', { deviceEui: CHAMELEON_EUI, chameleonEnabled: true, appliedSyncVersion: 6 }));
    assert.strictEqual(stale.ack.syncAck.result, 'REJECTED_PERMANENT');
    assert.strictEqual(stale.ack.syncAck.error, 'stale_sync_version');
    assert.deepStrictEqual(chameleonRow(db, CHAMELEON_EUI), { chameleon_enabled: 0, sync_version: 9 });

    // A device this gateway does not have is not acknowledged as applied.
    const missing = applyAndVerify(db, command('SET_CHAMELEON_CONFIG', { deviceEui: 'A84041000181C2FF', chameleonEnabled: true, appliedSyncVersion: 4 }));
    assert.strictEqual(missing.ack.syncAck.result, 'FAILED_RETRYABLE');
    assert.strictEqual(missing.ack.syncAck.error, 'postcondition_not_met');

    // Chameleon exists only on DRAGINO_LSN50; any other device row is left alone.
    const kiwi = applyAndVerify(db, command('SET_CHAMELEON_CONFIG', { deviceEui: KIWI_EUI, chameleonEnabled: true, appliedSyncVersion: 4 }));
    assert.strictEqual(kiwi.ack.syncAck.result, 'FAILED_RETRYABLE');
    assert.deepStrictEqual(chameleonRow(db, KIWI_EUI), { chameleon_enabled: 0, sync_version: 3 });

    // A malformed command fails at build time and goes straight to a FAILED ACK:
    // there is no effect to verify, and the postcondition must not relabel it.
    for (const bad of [
      { deviceEui: CHAMELEON_EUI },
      { deviceEui: CHAMELEON_EUI, chameleonEnabled: 'maybe' },
      { deviceEui: 'NOT-AN-EUI', chameleonEnabled: true },
      { deviceEui: CHAMELEON_EUI, chameleonEnabled: true, appliedSyncVersion: 0, syncVersion: 0 },
    ]) {
      const built = runFunction(node(UPDATE), { payload: command('SET_CHAMELEON_CONFIG', bad) });
      assert.strictEqual(built.syncAck.result, 'FAILED', 'invalid payload must fail: ' + JSON.stringify(bad));
      assert.strictEqual(built.topic, 'SELECT 1');
      const afterRouter = runFunction(node(ROUTER), built);
      assert(!afterRouter[0] && afterRouter[1], 'a FAILED SET_CHAMELEON_CONFIG must take the direct ACK path');
    }
    assert.deepStrictEqual(chameleonRow(db, CHAMELEON_EUI), { chameleon_enabled: 0, sync_version: 9 });

    // String forms the local route also accepts are honoured.
    const stringOn = command('SET_CHAMELEON_CONFIG', { deviceEui: CHAMELEON_EUI, chameleonEnabled: 'true', appliedSyncVersion: 10 });
    expectSuccess(applyAndVerify(db, stringOn), { commandId: stringOn.commandId });
    assert.deepStrictEqual(chameleonRow(db, CHAMELEON_EUI), { chameleon_enabled: 1, sync_version: 10 });
  } finally {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  }
}
```

Save this as `patch-chameleon-test.js` in your scratchpad:

```js
'use strict';
// One-shot: splice the Chameleon cases into scripts/verify-command-ack-postconditions.js.
// Usage (from the osi-os repo root): node <scratchpad>/patch-chameleon-test.js <scratchpad>/chameleon-cases.js.txt
const fs = require('fs');
const p = 'scripts/verify-command-ack-postconditions.js';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b) {
  const c = s.split(a).length - 1;
  if (c !== 1) throw new Error('anchor found ' + c + ' times: ' + a);
  s = s.replace(a, () => b);
}
rep("const LEGACY_ACK = 'e2e139678c3ddded';",
  "const LEGACY_ACK = 'e2e139678c3ddded';\nconst ROUTE_COMMAND = '934bf2bc19a8ce22';");
rep("      updated_at TEXT, sync_version INTEGER NOT NULL DEFAULT 0\n    );\n    CREATE TABLE applied_commands",
  "      updated_at TEXT, sync_version INTEGER NOT NULL DEFAULT 0,\n      type_id TEXT, chameleon_enabled INTEGER NOT NULL DEFAULT 0, deleted_at TEXT\n    );\n    CREATE TABLE applied_commands");
rep("  const verifiedTypes = ['UPDATE_SCHEDULE', 'UPSERT_SCHEDULE', 'ASSIGN_DEVICE_TO_ZONE', 'REMOVE_DEVICE_FROM_ZONE'];",
  "  const verifiedTypes = ['UPDATE_SCHEDULE', 'UPSERT_SCHEDULE', 'ASSIGN_DEVICE_TO_ZONE', 'REMOVE_DEVICE_FROM_ZONE', 'SET_CHAMELEON_CONFIG'];");
rep("verifyWiring();\nverifyRoutingMatrix();\nrunCases().then(() => {",
  fs.readFileSync(process.argv[2], 'utf8') + "\nverifyWiring();\nverifyRoutingMatrix();\nrunCases().then(runChameleonCases).then(() => {");
fs.writeFileSync(p, s);
console.log('patched ' + p);
```

Run: `bash -c 'cd <osi-os-worktree> && node <scratchpad>/patch-chameleon-test.js <scratchpad>/chameleon-cases.js.txt'`

Expected: `patched scripts/verify-command-ack-postconditions.js`. The devices fixture gains three columns with defaults; the existing cases select explicit columns and are unaffected. The Chameleon cases get their own temporary database because `runCases` ends by renaming `devices`.

- [ ] **Step 2: Run the verifier and watch it fail**

Run: `bash -c 'cd <osi-os-worktree> && node scripts/verify-command-ack-postconditions.js'`

Expected: exit 1 with `AssertionError [ERR_ASSERTION]: SET_CHAMELEON_CONFIG must enter postcondition verification only` (the routing matrix runs first; the router does not yet list the type).

- [ ] **Step 3: Edit flows.json with the one-shot script**

Save this as `chameleon-config-flows-edit.js` in your scratchpad:

```js
#!/usr/bin/env node
// One-shot flows.json edit: route and apply the cloud's SET_CHAMELEON_CONFIG.
// Run from the osi-os repo root. Never commit this file.
'use strict';
const fs = require('fs');
const path = require('path');

const CANONICAL = path.join(process.cwd(), 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(process.cwd(), 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}
function load(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) {
    throw new Error('roundtrip guard failed for ' + filePath + ' -- STOP');
  }
  return parsed;
}
function replaceOnce(flows, id, before, after) {
  const node = flows.find((n) => n.id === id);
  if (!node) throw new Error('missing node ' + id);
  const count = node.func.split(before).length - 1;
  if (count !== 1) throw new Error(id + ': expected exactly one anchor, found ' + count + ': ' + before);
  node.func = node.func.replace(before, () => after);
}

const flows = load(CANONICAL);
if (Buffer.compare(fs.readFileSync(CANONICAL), fs.readFileSync(MIRROR)) !== 0) {
  throw new Error('profiles differ before the edit -- STOP');
}

// 1. Route Command: SET_CHAMELEON_CONFIG joins the device-row commands on output 2 (Build UPDATE SQL).
replaceOnce(flows, '934bf2bc19a8ce22',
  "    'UPSERT_DEVICE_SOIL_DEPTHS',\n    'UNCLAIM_DEVICE'\n].includes(commandType)) {",
  "    'UPSERT_DEVICE_SOIL_DEPTHS',\n    'UNCLAIM_DEVICE',\n    'SET_CHAMELEON_CONFIG'\n].includes(commandType)) {");

// 2. Build UPDATE SQL: validate, then a version-guarded write of devices.chameleon_enabled.
replaceOnce(flows, '4f4a765f36cee6f3',
  "if (commandType === 'UPSERT_DEVICE_SOIL_DEPTHS') {",
  [
    "if (commandType === 'SET_CHAMELEON_CONFIG') {",
    "  var chameleonRaw = cmd.chameleonEnabled !== undefined ? cmd.chameleonEnabled : cmd.chameleon_enabled;",
    "  var chameleonFlag = ({ 'true': 1, '1': 1, 'false': 0, '0': 0 })[String(chameleonRaw)];",
    "  var chameleonVersion = Number(cmd.appliedSyncVersion || cmd.syncVersion || 0);",
    "  if (!/^[0-9A-F]{16}$/.test(deviceEui(cmd)) || chameleonFlag === undefined || !(Number.isInteger(chameleonVersion) && chameleonVersion > 0)) {",
    "    msg.syncAck.result = 'FAILED';",
    "    msg.syncAck.error = 'Invalid SET_CHAMELEON_CONFIG payload';",
    "    msg.topic = 'SELECT 1';",
    "    return msg;",
    "  }",
    "  msg._postconditionCommand.chameleonFlag = chameleonFlag;",
    "  msg.topic = 'UPDATE devices SET chameleon_enabled = ' + chameleonFlag + ', updated_at = ' + s(now) + ', sync_version = ' + chameleonVersion + ' WHERE deveui = ' + s(deviceEui(cmd)) + \" AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL AND COALESCE(sync_version, 0) <= \" + chameleonVersion;",
    "  return msg;",
    "}",
    "if (commandType === 'UPSERT_DEVICE_SOIL_DEPTHS') {",
  ].join('\n'));

// 3. Route command ACK verification: SET_CHAMELEON_CONFIG is verified; a build-time FAILED skips verification.
replaceOnce(flows, 'command-postcondition-route',
  "var verifiedTypes = ['UPDATE_SCHEDULE', 'UPSERT_SCHEDULE', 'ASSIGN_DEVICE_TO_ZONE', 'REMOVE_DEVICE_FROM_ZONE'];",
  "var verifiedTypes = ['UPDATE_SCHEDULE', 'UPSERT_SCHEDULE', 'ASSIGN_DEVICE_TO_ZONE', 'REMOVE_DEVICE_FROM_ZONE', 'SET_CHAMELEON_CONFIG'];");
replaceOnce(flows, 'command-postcondition-route',
  "if (verifiedTypes.includes(commandType)) return [msg, null];",
  "if (verifiedTypes.includes(commandType)) return ack.result === 'FAILED' ? [null, msg] : [msg, null];");

// 4. Build command postcondition query: read back the flag and version.
replaceOnce(flows, 'command-postcondition-build',
  "node.error('No postcondition query for command type ' + commandType, msg);",
  [
    "if (commandType === 'SET_CHAMELEON_CONFIG') {",
    "  msg.topic = 'SELECT chameleon_enabled, sync_version FROM devices WHERE deveui = ' + s(deviceEui(cmd)) + \" AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL LIMIT 1\";",
    "  return msg;",
    "}",
    "node.error('No postcondition query for command type ' + commandType, msg);",
  ].join('\n'));

// 5. Build verified command ACK: applied means the flag matches at or above the requested version.
replaceOnce(flows, 'command-postcondition-ack',
  "} else if (commandType === 'REMOVE_DEVICE_FROM_ZONE') {",
  [
    "} else if (commandType === 'SET_CHAMELEON_CONFIG') {",
    "  verified = !!row && sameNumber(row.chameleon_enabled, cmd.chameleonFlag) && Number(row.sync_version) >= requestedVersion;",
    "} else if (commandType === 'REMOVE_DEVICE_FROM_ZONE') {",
  ].join('\n'));

fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
load(CANONICAL);
load(MIRROR);
console.log('chameleon-config-flows-edit: wrote canonical + mirror');
```

Run: `bash -c 'cd <osi-os-worktree> && node <scratchpad>/chameleon-config-flows-edit.js'`

Expected: `chameleon-config-flows-edit: wrote canonical + mirror`. The script refuses to run if either profile fails the JSON roundtrip guard, if the profiles differ beforehand, or if any anchor is missing or appears twice.

- [ ] **Step 4: Run the verifier to green**

Run: `bash -c 'cd <osi-os-worktree> && node scripts/verify-command-ack-postconditions.js'`

Expected: `verify-command-ack-postconditions: PASS`, exit 0.

- [ ] **Step 5: Record the size-ratchet allowances**

Save this as `chameleon-config-allowances.js` in your scratchpad, then copy it to the repo root only for the run (it `require`s `./scripts/flows-size-scan`) and delete it afterwards:

```js
#!/usr/bin/env node
// One-shot: record the exact growth of the five nodes this fix touches in the
// flows size-ratchet allowances. Run from the osi-os repo root AFTER the flows edit.
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const { nodeSizes, totalChars } = require('./scripts/flows-size-scan');

const FLOWS = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const ALLOWANCES = 'scripts/verify-flows-size-ratchet-allowances.json';
const PURPOSE = 'Cloud Chameleon toggle fix (SET_CHAMELEON_CONFIG): the cloud now queues the contract\'s SET_CHAMELEON_CONFIG, and the edge routes it to Build UPDATE SQL, writes devices.chameleon_enabled under a sync_version guard, and verifies the write before ACKing.';
const NODES = {
  '934bf2bc19a8ce22': 'Route Command lists SET_CHAMELEON_CONFIG with the device-row commands that go to Build UPDATE SQL.',
  '4f4a765f36cee6f3': 'Build UPDATE SQL validates the payload (16-hex EUI, boolean-like chameleonEnabled, positive version) and emits a version-guarded UPDATE limited to live DRAGINO_LSN50 rows.',
  'command-postcondition-route': 'SET_CHAMELEON_CONFIG joins the verified types, and a build-time FAILED result skips verification and takes the direct ACK path.',
  'command-postcondition-build': 'Reads back chameleon_enabled and sync_version for the device.',
  'command-postcondition-ack': 'Verified when the flag matches at or above the requested sync_version.',
};

const head = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const base = JSON.parse(execFileSync('git', ['show', 'origin/main:' + FLOWS], { encoding: 'utf8', maxBuffer: 1 << 26 }));
const headSizes = nodeSizes(head);
const baseSizes = nodeSizes(base);
const allowances = JSON.parse(fs.readFileSync(ALLOWANCES, 'utf8'));

let sum = 0;
for (const [id, what] of Object.entries(NODES)) {
  const before = baseSizes.get(id).chars;
  const after = headSizes.get(id).chars;
  const delta = after - before;
  if (delta <= 0) throw new Error(id + ' did not grow; re-check the flows edit');
  sum += delta;
  const prior = allowances.node_allowances[id];
  allowances.node_allowances[id] = {
    delta,
    reason: (prior ? 'Supersedes the prior ' + prior.delta + ' entry, which origin/main already consumes in full. ' : '') +
      PURPOSE + ' ' + what + ' Measured with verify-flows-size-ratchet nodeSizes over both byte-identical profiles: origin/main ' +
      before + ' -> HEAD ' + after + ' = +' + delta + '.',
  };
  console.log(id, before, '->', after, '+' + delta);
}
const totalDelta = totalChars(head) - totalChars(base);
if (totalDelta !== sum) throw new Error('total growth ' + totalDelta + ' != node growth ' + sum + '; something else changed');
// total_allowance stays exactly as origin/main carries it: scripts/verify-live-gateway-identity.js
// pins its delta and provenance words, and its headroom already covers this change.
if (totalDelta > allowances.total_allowance.delta) throw new Error('total growth exceeds the carried total_allowance; STOP and ask');
fs.writeFileSync(ALLOWANCES, JSON.stringify(allowances, null, 2) + '\n');
console.log('total +' + totalDelta + ' (within the carried total_allowance ' + allowances.total_allowance.delta + ', left unchanged)');
```

Run: `bash -c 'cd <osi-os-worktree> && cp <scratchpad>/chameleon-config-allowances.js . && node chameleon-config-allowances.js; rm -f chameleon-config-allowances.js'`

Expected output:

```
934bf2bc19a8ce22 23827 -> 23855 +28
4f4a765f36cee6f3 19386 -> 20367 +981
command-postcondition-route 646 -> 710 +64
command-postcondition-build 1383 -> 1616 +233
command-postcondition-ack 2159 -> 2336 +177
total +1483 (within the carried total_allowance 71275, left unchanged)
```

If a number differs, the flows edit differs from this plan; stop and compare before continuing.

- [ ] **Step 6: Run the flows.json pre-commit gates**

Run each from the repo root (`bash -c 'cd <osi-os-worktree> && <command>'`):

| Command | Pass signal |
|---|---|
| `node scripts/verify-command-ack-postconditions.js` | `verify-command-ack-postconditions: PASS` |
| `node scripts/verify-flows-size-ratchet.js` | ends `verify-flows-size-ratchet: OK (...)` |
| `node scripts/verify-sync-flow.js` | prints `Sync flow verification passed`, chains `verify-live-gateway-identity.js` and profile parity, ends `All parity checks passed.`, exit 0 |
| `node scripts/verify-sync-contract.js` | `verify-sync-contract: OK` |
| `node scripts/test-contract-schemas.js` | `PASS: contract schema checks pass` |
| `node scripts/verify-sync-op-parity.js` | `verify-sync-op-parity: OK` (needs the sibling osi-server checkout it finds on its own) |
| `node scripts/test-flows-wiring.js` | `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed` |
| `node scripts/verify-flows-fn-parse.js` | `verify-flows-fn-parse: OK` |
| `node scripts/verify-no-new-silent-catch.js` | `verify-no-new-silent-catch: OK` |
| `node scripts/verify-no-stray-ddl.js` | `verify-no-stray-ddl: OK (...)` |
| `node scripts/flows-bare-require-scan.js` | exit 0 |
| `node scripts/verify-command-safety.js` | `verify-command-safety: OK` |
| `bash scripts/check-mqtt-topics.sh` | three `OK:` lines |

All of these passed on a scratch copy of this branch with the Task 2 changes applied while writing this plan (`verify-sync-op-parity.js` was run on the unmodified worktree, since the scratch copy had no sibling osi-server).

- [ ] **Step 7: Confirm the diff is exactly the intended surface**

Run: `bash -c 'cd <osi-os-worktree> && git status --short && cmp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json && echo profiles-identical && git diff --stat -- docs/contracts'`

Expected: four modified files (both `flows.json`, `scripts/verify-command-ack-postconditions.js`, `scripts/verify-flows-size-ratchet-allowances.json`), `profiles-identical`, and an empty `docs/contracts` diff. No scratch script is in the tree.

- [ ] **Step 8: Commit**

```bash
bash -c 'cd <osi-os-worktree> && git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-command-ack-postconditions.js scripts/verify-flows-size-ratchet-allowances.json && git commit -m "fix(sync): apply the cloud SET_CHAMELEON_CONFIG command

SET_CHAMELEON_CONFIG was in the registry and the contract, but Route
Command had no case for it and dropped it without an ACK. The cloud
sent SET_CHAMELEON_ENABLED instead, which the registry rejected, so the
cloud Chameleon toggle never reached the gateway either way.

Route Command now sends it to Build UPDATE SQL, which validates the
payload and writes devices.chameleon_enabled on live DRAGINO_LSN50 rows
under a sync_version guard. The ACK is postcondition-verified: SUCCESS
only when the flag holds at the requested version, stale_sync_version
when the edge is newer, FAILED_RETRYABLE when the device is absent. A
build-time FAILED now skips verification and ACKs directly.

Size-ratchet allowances record the exact growth of the five touched
nodes, superseding the two stale entries origin/main already consumed."'
```

---

### Task 3: Paired-PR hand-off (no push)

**Files:** none changed.

- [ ] **Step 1: Record the pairing for the orchestrator**

Report, for the orchestrator to put in both PR bodies:

- osi-server PR: "Paired with osi-os `feat/chameleon-enabled-cmd-fix`. Safe to deploy before the edge: an old edge accepts SET_CHAMELEON_CONFIG through its registry and drops it in Route Command, so the command NACKs after five leases, the same outcome as today. No contract file changes."
- osi-os PR: "Paired with osi-server `feat/chameleon-enabled-cmd-fix`. Idle until the cloud sends SET_CHAMELEON_CONFIG. No contract file changes; `verify-sync-contract.js` unchanged. Customer branches need a re-cut after merge (fix on main, then re-cut)."
- Merge order: either; deploy order: cloud first, then edge.
- Leftover `SET_CHAMELEON_ENABLED` rows: no migration; they NACK after five leases once the gateway polls.
- Owner follow-ups 1 and 2 from the top of this plan, if the owner wants issues filed.

- [ ] **Step 2: Verify both branches carry exactly their commits**

Run: `bash -c 'git -C <osi-os-worktree> log --oneline origin/main..HEAD && git -C <osi-server-worktree> log --oneline origin/main..HEAD'`

Expected: osi-os shows the plan commit and the Task 2 commit; osi-server shows the Task 1 commit.
