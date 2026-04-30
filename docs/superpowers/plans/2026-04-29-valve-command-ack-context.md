# Valve Command ACK Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve cloud sync context on edge-originated `VALVE_COMMAND` ACKs so the cloud accepts ACKs for gateway-backed valve commands instead of logging sender/context mismatch warnings.

**Architecture:** The backend ACK validator is correct: it requires ACKs to match the command sender and command context. The bug is in the edge Node-RED flow, where the generic `VALVE_COMMAND` route drops `eventUuid`, `aggregateType`, `aggregateKey`, and `appliedSyncVersion` before the STREGA status ACK is built. Fix the edge flow by carrying this context through the route, the STREGA log context, and the final `command_ack` payload.

**Tech Stack:** Node-RED `flows.json`, Node.js verification script, MQTT command ACK payloads, PostgreSQL live-state inspection for rollout safety.

---

## File Map

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
  - `Route Command` function node: preserve cloud command context on generic `VALVE_COMMAND`.
  - `Build STREGA downlink + emit log ctx` function node: copy command context into `_log_ctx` for status/ACK emission.
  - `Build Status + ACK` function node: emit the copied context in the MQTT `command_ack` payload.
- Modify: `scripts/verify-sync-flow.js`
  - Add a behavioral regression check that executes the real Node-RED function nodes for a `VALVE_COMMAND` fixture and verifies context survives through the final ACK payload.
- No change: `osi-server`
  - The server-side rejection is intentional and should remain strict.

---

### Task 1: Add Failing Regression Coverage

**Files:**
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add a behavioral check after the existing STREGA ACK assertions**

Insert this block immediately after the existing line:

```js
expectIncludes('Build Status + ACK', "commandType: 'VALVE_COMMAND'", 'tags manual STREGA valve ACK payloads with the cloud command type');
```

Add:

```js
pendingChecks.push((async () => {
  // Fixed fixture values mirror the live command-193 failure; the test has no hardware dependency.
  const gatewayEui = '0016C001F151B1D6';
  const valveEui = '70B3D57708000334';
  const fixture = {
    commandId: 193,
    commandType: 'VALVE_COMMAND',
    action: 'CLOSE',
    deviceEui: valveEui,
    devEui: valveEui,
    gatewayDeviceEui: gatewayEui,
    eventUuid: '2a90ee59-6473-4b84-a74e-4d79bcfb7a27',
    aggregateType: 'DEVICE',
    aggregateKey: valveEui,
    appliedSyncVersion: 44,
  };
  const expectedContext = {
    commandId: fixture.commandId,
    eventUuid: fixture.eventUuid,
    aggregateType: fixture.aggregateType,
    aggregateKey: fixture.aggregateKey,
    appliedSyncVersion: fixture.appliedSyncVersion,
    commandType: fixture.commandType,
  };

  const routeResult = await executeFunctionNodeById('934bf2bc19a8ce22', { payload: fixture });
  const valveMsg = Array.isArray(routeResult) ? routeResult[0] : null;
  const routeData = valveMsg && valveMsg.payload && valveMsg.payload.data;
  if (!routeData) {
    fail('VALVE_COMMAND route did not produce an actuator_command payload');
    return;
  }
  for (const [key, value] of Object.entries(expectedContext)) {
    if (routeData[key] !== value) {
      fail(`VALVE_COMMAND route dropped ACK context field ${key}`);
    }
  }

  const stregaResult = await executeFunctionNodeById('cdbaa3891d40d7a1', valveMsg, {
    env: {
      CHIRPSTACK_APP_ACTUATORS: 'actuators-app',
      DEVICE_EUI: gatewayEui,
    },
  });
  const logMsg = Array.isArray(stregaResult) ? stregaResult[1] : null;
  const logCtx = logMsg && logMsg._log_ctx;
  if (!logCtx) {
    fail('STREGA downlink did not emit log context for VALVE_COMMAND');
    return;
  }
  for (const [key, value] of Object.entries(expectedContext)) {
    if (logCtx[key] !== value) {
      fail(`STREGA log context dropped ACK context field ${key}`);
    }
  }

  const statusResult = await executeFunctionNodeById('c8628cffe45f64f7', logMsg, {
    env: {
      DEVICE_EUI: gatewayEui,
    },
    flowState: {
      lastCommandId: fixture.commandId,
    },
  });
  const ackMsg = Array.isArray(statusResult) ? statusResult[1] : null;
  const ackPayload = ackMsg && typeof ackMsg.payload === 'string' ? JSON.parse(ackMsg.payload) : null;
  if (!ackPayload) {
    fail('Build Status + ACK did not emit a command_ack payload for VALVE_COMMAND');
    return;
  }
  for (const [key, value] of Object.entries(expectedContext)) {
    if (ackPayload[key] !== value) {
      fail(`VALVE_COMMAND command_ack dropped ACK context field ${key}`);
    }
  }
  if (ackPayload.deviceEui !== valveEui) {
    fail('VALVE_COMMAND command_ack did not preserve the valve deviceEui');
  }
  if (ackPayload.gatewayDeviceEui !== gatewayEui) {
    fail('VALVE_COMMAND command_ack did not preserve the gatewayDeviceEui');
  }
})().catch((error) => {
  fail(`failed to execute VALVE_COMMAND ACK context fixture: ${error.message}`);
}));
```

- [ ] **Step 2: Run the verification and confirm it fails for the right reason**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected before the implementation:

```text
FAIL: VALVE_COMMAND route dropped ACK context field eventUuid
FAIL: VALVE_COMMAND route dropped ACK context field aggregateType
FAIL: VALVE_COMMAND route dropped ACK context field aggregateKey
FAIL: VALVE_COMMAND route dropped ACK context field appliedSyncVersion
FAIL: VALVE_COMMAND route dropped ACK context field commandType
```

The script may print additional existing `OK ...` lines. The important signal is that the new fixture fails because the context fields are missing.

- [ ] **Step 3: Commit the failing test**

```bash
git add scripts/verify-sync-flow.js
git commit -m "test: cover valve command ack context"
```

---

### Task 2: Preserve Context Through the Edge Flow

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`

- [ ] **Step 1: Update `Route Command` for generic `VALVE_COMMAND`**

In the `Route Command` function node, replace the current `VALVE_COMMAND` block with:

```js
if (commandType === 'VALVE_COMMAND') {
    var valveTargetEui = String(cmd.deviceEui || cmd.devEui || '').trim().toUpperCase();
    msg.payload = {
        type: 'actuator_command',
        device: { devEui: valveTargetEui },
        data: {
            action: cmd.action,
            duration_minutes: cmd.duration_minutes || 0,
            reason: 'osi_server_command',
            commandId: cmd.commandId || null,
            eventUuid: cmd.eventUuid || null,
            aggregateType: cmd.aggregateType || null,
            aggregateKey: cmd.aggregateKey || null,
            appliedSyncVersion: cmd.appliedSyncVersion !== undefined && cmd.appliedSyncVersion !== null ? cmd.appliedSyncVersion : null,
            commandType: 'VALVE_COMMAND',
            deviceEui: valveTargetEui,
            gatewayDeviceEui: String(cmd.gatewayDeviceEui || cmd.gateway_device_eui || piEui || '').trim().toUpperCase()
        }
    };
    return [msg, null, null, null, null];
}
```

This preserves the cloud command context before the message leaves the REST pending-command tab and enters the STREGA actuator tab.

- [ ] **Step 2: Preserve `appliedSyncVersion` in the direct STREGA ACK helper**

In the `Build STREGA downlink + emit log ctx` function node, find this line inside the `ack(result, error, extra)` helper:

```js
      appliedSyncVersion: data.appliedSyncVersion || null,
```

Replace it with:

```js
      appliedSyncVersion: data.appliedSyncVersion !== undefined && data.appliedSyncVersion !== null ? data.appliedSyncVersion : null,
```

This mirrors the `Route Command` and `Build Status + ACK` null handling so a numeric `0` cannot be collapsed to `null` on direct error/config ACKs.

- [ ] **Step 3: Add command context to the successful STREGA `_log_ctx`**

In the `Build STREGA downlink + emit log ctx` function node, target only the success-path `logMsg` block inside this guard:

```js
if (action !== 'SET_INTERVAL' && action !== 'SET_MAGNET_MODE') {
  logMsg = {
    _log_ctx: {
```

Do not edit the earlier `failedLogMsg = { _log_ctx: { ... } }` block for the missing `CHIRPSTACK_APP_ACTUATORS` early exit. Replace the success-path `_log_ctx` object with:

```js
_log_ctx: {
  devEui,
  zone_id: Number.isFinite(zoneId) ? zoneId : null,
  action: action,
  duration_minutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
  reason,
  commandId: data.commandId || null,
  eventUuid: data.eventUuid || null,
  aggregateType: data.aggregateType || null,
  aggregateKey: data.aggregateKey || null,
  appliedSyncVersion: data.appliedSyncVersion !== undefined && data.appliedSyncVersion !== null ? data.appliedSyncVersion : null,
  commandType: String(data.commandType || '').trim().toUpperCase() || null,
  gatewayDeviceEui,
  created_at: new Date().toISOString(),
  extra_json: JSON.stringify({
    valve_action: valveAction || null,
    unit: unit || null,
    amount: Number.isFinite(amount) ? amount : null,
    percentage: Number.isFinite(percentage) ? percentage : null,
    return_position: returnPosition || null
  })
}
```

This is required because `OPEN` and `CLOSE` valve actions do not emit the direct STREGA ACK path; their successful ACK is built later from `_log_ctx`.

- [ ] **Step 4: Emit context from `Build Status + ACK`**

In the `Build Status + ACK` function node, replace the full function body with:

```js
var eui = String(env.get('DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase();
var ctx = msg._log_ctx || {};
var commandId = ctx.commandId || flow.get('lastCommandId');
var action = String(ctx.action || '').toUpperCase();
var state = (action === 'OPEN' || action === 'OPEN_FOR_DURATION') ? 'OPEN' : 'CLOSED';
var ts = new Date().toISOString();
var deviceEui = String(ctx.devEui || '').trim().toUpperCase() || null;
var gatewayDeviceEui = String(ctx.gatewayDeviceEui || eui).trim().toUpperCase();
var commandType = String(ctx.commandType || 'VALVE_COMMAND').trim().toUpperCase() || 'VALVE_COMMAND';
var appliedSyncVersion = ctx.appliedSyncVersion !== undefined && ctx.appliedSyncVersion !== null ? ctx.appliedSyncVersion : null;

var statusMsg = {
    topic: 'devices/' + eui + '/status',
    payload: JSON.stringify({
        deviceEui: deviceEui,
        gatewayDeviceEui: gatewayDeviceEui,
        state: state,
        timestamp: ts
    }),
    qos: 1
};
var ackMsg = {
    topic: 'devices/' + eui + '/command_ack',
    payload: JSON.stringify({
        deviceEui: deviceEui,
        gatewayDeviceEui: gatewayDeviceEui,
        commandId: commandId || null,
        eventUuid: ctx.eventUuid || null,
        aggregateType: ctx.aggregateType || null,
        aggregateKey: ctx.aggregateKey || null,
        result: 'SUCCESS',
        state: state,
        commandType: commandType,
        appliedSyncVersion: appliedSyncVersion,
        timestamp: ts
    }),
    qos: 1
};
return [statusMsg, ackMsg];
```

This keeps the legacy local/manual ACK behavior intact while adding the strict cloud context when the action came from a synced cloud command.

- [ ] **Step 5: Update stale static assertions for the new variable-based ACK body**

In `scripts/verify-sync-flow.js`, replace:

```js
expectIncludes('Build Status + ACK', 'gatewayDeviceEui: eui', 'includes the gateway transport identity in cloud status payloads');
expectIncludes('Build Status + ACK', "commandType: 'VALVE_COMMAND'", 'tags manual STREGA valve ACK payloads with the cloud command type');
```

with:

```js
expectIncludes('Build Status + ACK', 'gatewayDeviceEui: gatewayDeviceEui', 'includes the gateway transport identity in cloud status payloads');
expectIncludes('Build Status + ACK', "ctx.commandType || 'VALVE_COMMAND'", 'defaults manual STREGA valve ACK payloads to the cloud command type');
```

These `expectIncludes` checks are raw source-string checks. Without this update, the behavior can be fixed while verification still fails on stale literal snippets.

- [ ] **Step 6: Run the verification and confirm it passes**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected:

```text
OK ...
```

No `FAIL:` lines should be printed. The process exit code must be `0`.

- [ ] **Step 7: Commit the implementation**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json scripts/verify-sync-flow.js
git commit -m "fix: preserve valve command ack context"
```

---

### Task 3: Local Verification Pass

**Files:**
- Verify only.

- [ ] **Step 1: Check JSON validity**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8')); console.log('flows.json valid')"
```

Expected:

```text
flows.json valid
```

- [ ] **Step 2: Run the sync verification suite**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected:

```text
OK ...
```

No `FAIL:` lines and exit code `0`.

- [ ] **Step 3: Check for whitespace or patch damage**

Run:

```bash
git diff --check
```

Expected: no output and exit code `0`.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff --stat HEAD~2..HEAD
git diff HEAD~2..HEAD -- scripts/verify-sync-flow.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
```

Confirm the diff is limited to:

- the new `VALVE_COMMAND` ACK-context fixture,
- context preservation in `Route Command`,
- context propagation through STREGA `_log_ctx`,
- context emission in `Build Status + ACK`.

---

### Task 4: Live Rollout Safety For Existing Stale Commands

**Files:**
- No repo file changes.

Command `193` is not the only stale command. Live inspection showed `189`, `192`, and `193` are all `SENT` `VALVE_COMMAND` rows for gateway `0016C001F151B1D6`. Deploying the edge fix without handling these rows can cause the edge to replay old valve commands and then ACK them successfully.

- [ ] **Step 1: Confirm there is no service/API expiry path for stale commands**

Run:

```bash
rg -n "cancel|expire|device_commands|CommandStatus" /home/phil/Repos/osi-server/backend/src/main/java/org/osi/server -g '*.java'
```

Expected: command creation, ACK completion, pending-command delivery, and status reads exist, but there is no operator-facing command cancel/expire API. Only use the direct SQL cleanup below if this remains true. If a cancel/expire service path exists, use that path instead of SQL and still run Steps 3 and 5 to verify the queue.

- [ ] **Step 2: Take a cloud database backup before status cleanup**

Run from the local workstation:

```bash
ssh -i ~/.ssh/osi_server_rollout -o IdentitiesOnly=yes -o BatchMode=yes rocky@83.228.220.63 \
  'set -e; ts=$(date -u +%Y%m%d-%H%M%S); mkdir -p /home/rocky/backups/ack-context-$ts; cd /home/rocky/docker/osi-server/docker; docker compose exec -T postgres pg_dump -U osiserver osiserver > /home/rocky/backups/ack-context-$ts/osiserver.sql; echo /home/rocky/backups/ack-context-$ts'
```

Expected: prints the backup directory path.

- [ ] **Step 3: Re-list stale pending valve commands**

Run:

```bash
ssh -i ~/.ssh/osi_server_rollout -o IdentitiesOnly=yes -o BatchMode=yes rocky@83.228.220.63 \
  'cd /home/rocky/docker/osi-server/docker && docker compose exec -T postgres psql -U osiserver -d osiserver -P pager=off -c "select c.id, c.command_type, c.status, c.created_at, c.sent_at, d.device_eui as gateway_eui, c.aggregate_key as valve_eui, c.event_uuid, c.payload_json from device_commands c join devices d on d.id = c.device_id where d.device_eui = '\''0016C001F151B1D6'\'' and c.command_type = '\''VALVE_COMMAND'\'' and c.status in ('\''SENT'\'', '\''PENDING'\'') order by c.created_at;"'
```

Expected before cleanup: rows for `189`, `192`, and `193`, unless they were already handled separately.

- [ ] **Step 4: Expire the stale commands before deploying the edge fix**

Run only after confirming these old `2026-04-25` commands should not be replayed:

```bash
ssh -i ~/.ssh/osi_server_rollout -o IdentitiesOnly=yes -o BatchMode=yes rocky@83.228.220.63 \
  'cd /home/rocky/docker/osi-server/docker && docker compose exec -T postgres psql -U osiserver -d osiserver -P pager=off -c "update device_commands c set status = '\''FAILED'\'', executed_at = now(), error_message = '\''Expired during VALVE_COMMAND ACK context repair; not replayed'\'' from devices d where c.device_id = d.id and d.device_eui = '\''0016C001F151B1D6'\'' and c.command_type = '\''VALVE_COMMAND'\'' and c.status in ('\''SENT'\'', '\''PENDING'\'') and c.id in (189,192,193) returning c.id, c.status, c.error_message;"'
```

Expected:

```text
 id  | status | error_message
-----+--------+-----------------------------------------------------
 189 | FAILED | Expired during VALVE_COMMAND ACK context repair; not replayed
 192 | FAILED | Expired during VALVE_COMMAND ACK context repair; not replayed
 193 | FAILED | Expired during VALVE_COMMAND ACK context repair; not replayed
```

If any row is not returned, re-run Step 3 and inspect the current status before proceeding.

- [ ] **Step 5: Confirm the pending queue is clear for that gateway**

Run:

```bash
ssh -i ~/.ssh/osi_server_rollout -o IdentitiesOnly=yes -o BatchMode=yes rocky@83.228.220.63 \
  'cd /home/rocky/docker/osi-server/docker && docker compose exec -T postgres psql -U osiserver -d osiserver -P pager=off -c "select count(*) as stale_valve_commands from device_commands c join devices d on d.id = c.device_id where d.device_eui = '\''0016C001F151B1D6'\'' and c.command_type = '\''VALVE_COMMAND'\'' and c.status in ('\''SENT'\'', '\''PENDING'\'');"'
```

Expected:

```text
 stale_valve_commands
----------------------
                    0
```

---

### Task 5: Edge Deployment And Post-Deploy Verification

**Files:**
- Deploy updated `flows.json` to the target edge gateway after the repo verification passes and stale cloud commands are expired.

The target edge gateway SSH address is not stored in this repository. Do not invent one. Before executing this task, obtain the target gateway address for gateway EUI `0016C001F151B1D6` from the operator or the existing deployment inventory.

- [ ] **Step 1: Back up the edge gateway before rollout**

On the target Pi, create a timestamped backup including Node-RED state and live DB sidecars:

```bash
ts=$(date -u +%Y%m%d-%H%M%S)
mkdir -p /data/db/backups/osi-os-$ts
cp -a /data/db /data/db/backups/osi-os-$ts/data-db
cp -a /srv/node-red /data/db/backups/osi-os-$ts/node-red
cp -a /etc/init.d/node-red /data/db/backups/osi-os-$ts/node-red.init
cp -a /srv/node-red/flows.json /data/db/backups/osi-os-$ts/flows.json
cp -a /srv/node-red/settings.js /data/db/backups/osi-os-$ts/settings.js
echo /data/db/backups/osi-os-$ts
```

Expected: prints the backup directory path. If any copy fails, stop and inspect before rollout.

- [ ] **Step 2: Deploy only the updated Node-RED flow**

Copy the verified repo flow to the Pi:

```bash
: "${TARGET_GATEWAY_HOST:?Set TARGET_GATEWAY_HOST to the confirmed gateway SSH host for 0016C001F151B1D6}"
scp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json root@"$TARGET_GATEWAY_HOST":/srv/node-red/flows.json
ssh root@"$TARGET_GATEWAY_HOST" '/etc/init.d/node-red restart'
```

This command intentionally does not copy or overwrite `/data/db/farming.db`.

- [ ] **Step 3: Verify Node-RED restarted**

Run:

```bash
: "${TARGET_GATEWAY_HOST:?Set TARGET_GATEWAY_HOST to the confirmed gateway SSH host for 0016C001F151B1D6}"
ssh root@"$TARGET_GATEWAY_HOST" '/etc/init.d/node-red status; logread | tail -80'
```

Expected:

- Node-RED is running.
- No syntax error for `flows.json`.
- No immediate crash loop.

- [ ] **Step 4: Send a fresh valve command and verify ACK acceptance**

Create a new valve command through the normal OSI Cloud UI or API for the same valve. Do not reuse command `189`, `192`, or `193`.

Confirm a new command row landed before watching logs:

```bash
ssh -i ~/.ssh/osi_server_rollout -o IdentitiesOnly=yes -o BatchMode=yes rocky@83.228.220.63 \
  'cd /home/rocky/docker/osi-server/docker && docker compose exec -T postgres psql -U osiserver -d osiserver -P pager=off -c "select c.id, c.command_type, c.status, c.created_at, c.sent_at, c.payload_json from device_commands c join devices d on d.id = c.device_id where d.device_eui = '\''0016C001F151B1D6'\'' and c.command_type = '\''VALVE_COMMAND'\'' and c.created_at > now() - interval '\''15 minutes'\'' order by c.created_at desc limit 5;"'
```

Expected: the freshly-created command appears with a new ID and `PENDING` or `SENT` status.

Then on the cloud server, run:

```bash
ssh -i ~/.ssh/osi_server_rollout -o IdentitiesOnly=yes -o BatchMode=yes rocky@83.228.220.63 \
  'cd /home/rocky/docker/osi-server/docker && docker compose logs --since=10m backend | grep -E "Rejecting command ACK|Rejected command ACK|command_ack|VALVE_COMMAND" | tail -80'
```

Expected:

- No new `Rejecting command ACK ... due to sender/context mismatch` warning for the fresh command.
- The fresh command row changes out of `SENT` after the ACK is received.

- [ ] **Step 5: Query the fresh command status**

Run:

```bash
ssh -i ~/.ssh/osi_server_rollout -o IdentitiesOnly=yes -o BatchMode=yes rocky@83.228.220.63 \
  'cd /home/rocky/docker/osi-server/docker && docker compose exec -T postgres psql -U osiserver -d osiserver -P pager=off -c "select c.id, c.command_type, c.status, c.sent_at, c.executed_at, c.ack_payload_json, c.error_message from device_commands c join devices d on d.id = c.device_id where d.device_eui = '\''0016C001F151B1D6'\'' and c.command_type = '\''VALVE_COMMAND'\'' order by c.created_at desc limit 5;"'
```

Expected for the fresh command:

- status is `ACKNOWLEDGED`,
- `ack_payload_json` contains `eventUuid`, `aggregateType`, `aggregateKey`, `deviceEui`, and `gatewayDeviceEui`,
- `error_message` is empty.

---

## Review Consolidation

External review findings incorporated into this plan:

- The root-cause diagnosis is confirmed: `VALVE_COMMAND` is the outlier that drops cloud ACK context while other command routes preserve it.
- Task 2 now updates the two stale raw `expectIncludes` assertions that would otherwise fail after the `Build Status + ACK` body becomes variable-based.
- The STREGA `_log_ctx` edit now targets only the success-path `logMsg` block and explicitly avoids the earlier `failedLogMsg` early-exit block.
- `Route Command` and the direct STREGA ACK helper now preserve `appliedSyncVersion` with explicit null/undefined checks so numeric `0` cannot collapse to `null`.
- Task 4 now checks for an in-app command expiry/cancel path before using direct SQL; direct SQL remains the fallback because the current server code exposes creation, delivery, status, and ACK completion, but no operator cancel endpoint.
- The test fixture notes that the EUI values mirror the live command-193 failure but are fixed strings inside the test, not a dependency on attached hardware.
- Task 5 now includes a pre-check query to confirm a fresh command row exists before watching logs for ACK acceptance.
- The `Build Status + ACK` rewrite is intentionally context-first while keeping `flow.get('lastCommandId')` and the `VALVE_COMMAND` fallback for legacy manual/local valve actions.
- The `gatewayDeviceEui` value is now resolved from `ctx.gatewayDeviceEui || eui`, preserving the existing environment fallback while allowing cloud command context to win when present.

---

## Self-Review Checklist

- Spec coverage: The plan addresses the observed command `193` mismatch, the edge flow root cause, the success ACK path for `OPEN`/`CLOSE`, direct error ACK context, local verification, and live stale-command replay safety.
- Placeholder scan: The only unresolved runtime value is the target gateway SSH host, which is intentionally not stored in the repo and must be supplied before edge deployment. All repo implementation and cloud inspection commands are exact.
- Type consistency: The plan uses the same field names required by `CommandService.matchesAckSource`: `eventUuid`, `aggregateType`, `aggregateKey`, and `appliedSyncVersion`.
