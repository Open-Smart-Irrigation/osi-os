# Issue #233 Phase A exact plan at W: S2120 unclaim gate and peer-database extraction (packet r1)

Status: **SOURCE ONLY. Every command, editor, extractor, test, mutation and gate below is UNRUN.** This plan replaces the historical U exact plan for current main W. It keeps the accepted Phase A behavior (lifecycle hunks L1 to L7, routes hunks R1 to R4, the adapter's third output and the batch tie-break) and the accepted W extraction design: a thin `s2120-unclaim-gate` node between `reject-indefinite-open` and `command-dedupe-dispatch`, its owner `routes.s2120UnclaimGate`, and `replication.flowPeerDb` in place of four inline peer-database objects in the two batch builders. `command-dedupe-dispatch` and `sync-pending-split` stay byte-identical to W, no existing function node grows, the per-profile total falls from 1617691 to 1616317, and the retired allowance ledger is neither read for permission nor written. The downstream command-ledger load stays mandatory. Deployment and rollback across mixed versions are held (section 15). Phase B, the third-provider council vote and the maintainer risk-merge decision stay held.

| Object | Value |
|---|---|
| Edge base B (current main W) | `0eaa6d87892708c66f5a004bf121656c5a52b17e`, tree `4ee9b6487adf789b0a9341f4d1ef846f6dc7a656`; sole parent `5e7b6a02dc958208334ffb727b8467fea4ce607a` |
| Historical U plan (immutable, admits nothing here) | base `5dce03738fd8303a5dbf89f2f06533740853ebba`, plan commit `ba6111f0a867437635fa4d369704482cab0ce4d0`, test commit `9250a13f638e049d443109ed056239198b500408`, plan SHA-256 `ca504494012bd1c46dcd5c5932e86bf52c870a7640b67863acc40973e09196ed`, editor SHA-256 `5d947b67be74b2f1ec0f0b8f6e81cafc004b3bf4593e8a9bec481826f6293668` |
| Plan path in the repository | `docs/superpowers/plans/issue-233-exact-plan.md` (absent at B) |
| Receipt generation | `issue-233-phase-a-execute-r7-*`; r1 to r6 exist and are never reused |

## 1. Decision and boundary

Phase A keeps every behavior the R6 and U reviews accepted:

1. **Selected-pair detach, both flag states.** For a `SENSECAP_S2120`, `DELETE /api/irrigation-zones/:id/devices/:deveui` removes only the selected `(station, zone)` row, bumps the weather set version and clears the primary zone only when it equals the selected zone (hunks L3, L4, R1 to R3).
2. **Cloud S2120 `UNCLAIM_DEVICE`, trusted and cloud only.** One lifecycle transaction deletes every link and bumps the weather version while the station is still claimed, then clears claim and primary. Holds write nothing and send no ACK. A terminal decision is one bound ledger row and one REST ACK row, then one MQTT copy of the same bytes (section 3).
3. **Cloud-only boundary.** Only `lifecycle.applyS2120CloudUnclaim` can set the private all-links flag. Local `DELETE /api/devices/:deveui` keeps today's behavior (case H01).
4. **Account unlink** stays a preservation path (case A01).

The W extraction changes where two accepted pieces live, not what they decide:

- The trusted lease joins the protected envelope in `routes.s2120UnclaimGate`, not in the two intake builders. Both builders set `command.leasedToGateway` from the cloud response after copying the raw payload, and `reject-indefinite-open`, the only node in between, writes neither that field nor the envelope.
- The live-S2120 classification runs in the gate, before the generic replay check, on the gate's own DB handle. An S2120 unclaim leaves on gate output 2 for `journal-command-apply-fn`, the node that dedupe output 1 feeds; the adapter classifies again before any mutation.
- The four inline peer-database objects in `sync-outbox-build` (one) and `sync-force-build` (three) become calls to `replication.flowPeerDb` with the same statement sequence and the same rollback warning labels.

The missing-ledger contract is exact, and nothing here implements a degraded mode. `routes.conditionalLifecycleCommand` loads `osi-db-helper`, `osi-command-ledger`, `osi-irrigation-policy` and `osi-valve-control` before its S2120 branch (W `routes.js:564-576`) and returns `[null, null]` when any load fails. With a persistent ledger load failure a live S2120 unclaim passes the gate on output 2 and stops at `conditional-lifecycle-command-adapter` with `lifecycle command adapter unavailable: <detail>`; any other unclaim passes on output 1 and stops at `command-dedupe-dispatch` with `Command helpers unavailable: <detail>`. Neither applies the unclaim, writes a ledger decision or sends an ACK (cases L01, L02). The gate may first read identity and close its handle.

Not changed: `command-dedupe-dispatch`, `sync-pending-split`, `weather-zones-command-apply-fn`, `deploy.sh`, `scripts/deploy-fetch-list.js`, `osi-command-ledger` (its deploy SHA pins stay valid), `osi-lib` and its registry, package and lock files, every schema, seed, migration and bundled DB, both journal generators, `scripts/verify-flows-size-ratchet-allowances.json` and `scripts/flows-growth-exceptions.json`. No growth exception is requested. `UNCLAIM_DEVICE` stays outside the protected command set. String-payload delivery is not supported: the gate classifies a parsed copy and returns the original message, as the accepted chain did, and both real intake builders emit objects. No lease-expiry rule is added; `leaseExpiresAt` is neither checked nor bound.

## 2. What changed from the U plan, and why

| Item | U plan at `5dce0373` | This plan at B |
|---|---|---|
| Lease stamp | F1 in `sync-pending-split`, F2 in `sync-force-build` | R5: `routes.s2120UnclaimGate` stamps `envelope.leasedToGateway` from `command.leasedToGateway`. Both builders unchanged at those anchors. |
| S2120 replay routing | F3 inside `command-dedupe-dispatch` (+424 characters) | New thin node `s2120-unclaim-gate` (1080 characters) between `reject-indefinite-open` and the dedupe node. Dedupe byte-identical to B. |
| Allowance | Stage 2 rewrote the dedupe entry of `scripts/verify-flows-size-ratchet-allowances.json` | That file is retired and frozen at B (AGENTS.md "New features go into modules"). The editor proves it and `scripts/flows-growth-exceptions.json` byte-equal to B before and after writing; gate 61 proves it on the candidate. The size contract in section 9 replaces the allowance check. |
| Builder size | Outbox and force grew under standing allowances | `flowPeerDb` removes four inline objects: outbox 26926 to 26348, force 82239 to 80363. |
| Dedupe pins | T3b repinned dedupe; T6b asked for four bindings; T7 repinned both generator literals | Withdrawn. Dedupe keeps its B digest and three bindings, and both generators keep their B literals. Their test now passes at Stage 1, so it is a GREEN gate (55), not a RED command. T3b and T4b add the gate's own policy; T6b checks the gate's contract. |
| New gate checks | none | T8 (gate in the helper-failure matrix), T9 (peer factory calls), V1 (`verify-sync-flow.js` wires), V2 (valve traversal runs the gate), RT1 (three `flowPeerDb` module tests, both profiles). |
| Fixture | 34 checks per profile | 44 per profile: F01 force delivery, G01 to G03 gate contracts, L01 and L02 with injector-disconnected controls, M4 lease mutant, M5 gate-route mutant (section 12). |
| Recipe | 9 Stage 1 paths, 7 Stage 2 paths, generation r6 | 11 and 8, generation r7, RED 15 for the module tests, new GREEN gates 56 to 61. |

## 3. Cloud S2120 decision matrix

Order inside `applyS2120CloudUnclaim`. Steps 1 to 3 run before the transaction; 4 onward run inside one `BEGIN IMMEDIATE` transaction under the discovered valve writers.

| Step | Condition | Outcome |
|---|---|---|
| 0 | Neither outer `aggregateKey` nor raw `payload.deviceEui` names a live S2120 (`s2120UnclaimIdentity`) | Not this branch: the gate passes the command to the generic replay check on output 1, and the adapter keeps its unchanged generic path. |
| 1 | `commandId` is not a positive safe integer | Hold `invalid_command_id`: no ACK, no write. |
| 2 | Runtime gateway (env `DEVICE_EUI`, else `GATEWAY_DEVICE_EUI`) invalid; lease missing, blank, malformed or different | Hold `lease_gateway_unavailable_or_mismatch`. |
| 3 | The classified station matches neither identity | Hold `unidentifiable_device`. |
| 4 | `sync_link_state` not linked | Hold `link_inactive`. |
| 5 | Link gateway non-blank and different from runtime | Hold `link_gateway_transition`. |
| 6 | Pending link attempt (`linkFence`) | Hold `link_in_progress`. |
| 7 | `applied_commands` row for this id exists | Replay only if type `UNCLAIM_DEVICE`, originator `cloud`, same device, same gateway, same binding hash and a readable stored ACK with the same id, type, aggregate and event. Then keep exactly one identical pending ACK row (insert one if none); a different or second pending row throws. Anything else throws `command_id_binding_conflict`: rollback, no ACK. |
| 8 | Station row missing or no longer S2120 | Hold `type_changed_or_missing`. |
| 9 | Stored device version unsafe | Terminal REJECTED_PERMANENT `invalid_version`, version 0. |
| 10 | Payload or envelope breaks the legacy contract | Terminal REJECTED_PERMANENT `malformed_command` or `invalid_version`; untrusted aggregate fields null. |
| 11 | Stored device or zone gateway non-blank and different, or not a valid EUI | Terminal CONFLICT with that code. |
| 12 | target < current | CONFLICT `stale_sync_version`. |
| 13 | target = current | APPLIED `duplicate:true` only when claim, primary and links are all empty; else CONFLICT `equal_version_postcondition_failed`. |
| 14 | target > current + 1 (or current at the safe limit) | CONFLICT `version_gap`. |
| 15 | target = current + 1, unclaimed | CONFLICT `orphaned_weather_links` when links or primary remain, else `version_gap`. |
| 16 | target = current + 1, claimed by a user other than the pre-read | CONFLICT `stale_device_state`. |
| 17 | target = current + 1, claimed as pre-read | Lifecycle `device_unclaim` with the private flag: bind a blank gateway, delete links and bump the weather version, then the existing device UPDATE. Post-read claim, primary, version, empty links, one weather event (when links existed) before one `DEVICE_UNCLAIMED`, and `zone_uuids` `[]`. Terminal APPLIED at target. |
| any | A throw before COMMIT (SQL fault, postcondition, binding conflict) | Rollback of canonical rows, ledger and ACK outbox; no MQTT; `node.error` names the code. Never `FAILED_RETRYABLE`. |
| any | Membership drift three times | Hold `membership_drift`. |

ACK fields: `commandId, status, result, appliedAt, appliedSyncVersion, duplicate, reason, detail, eventUuid, commandType, aggregateType, aggregateKey, effectKey, gatewayDeviceEui, resourceUuid, payloadHash, reasonCode, valveCleanup`. `status` is ACKED, CONFLICT or NACKED; `payloadHash` is always null; `valveCleanup` is the lifecycle's own AUTH-09 outcome (`not_applicable`/`not_a_valve` when applied, `not_attempted` with the code when refused). The binding hash is SHA-256 of the recursively key-sorted JSON of `commandId, eventUuid, commandType, aggregateType, aggregateKey, appliedSyncVersion, effectKey, leasedToGateway, payload, runtimeGatewayDeviceEui` with undefined normalized to null. A held command leaves no local binding; this plan relies on the server's immutable command row across leases, as R2 to R6 accepted. Server S turns the fifth retryable answer for this unprotected type into NACKED; this branch never sends one.

## 4. Gate, owner gate and failure contract

`s2120-unclaim-gate` (function node, outputs 2, `libs` = `osiLib` only, On Start and On Stop empty) parses `msg.payload` when it is a string; a parse failure returns `[msg, null]`, so the dedupe node reports it as at B. A command whose envelope type is not `UNCLAIM_DEVICE` returns `[msg, null]` without loading anything. For an `UNCLAIM_DEVICE` it loads `osi-irrigation-policy`; on failure it calls `node.error('S2120 unclaim owner unavailable: ' + error, msg)` and returns `[null, null]`. Otherwise it returns `routes.s2120UnclaimGate({ msg, node, osiLib, policy, command, envelope })`. Output 1 feeds `command-dedupe-dispatch`; output 2 feeds `journal-command-apply-fn`. `reject-indefinite-open` output 1 moves from the dedupe node to the gate; its function is unchanged.

`routes.s2120UnclaimGate` stamps the lease, loads `osi-db-helper` (failure: one `node.error` with the same prefix, `[null, null]`, no open), constructs one `Database('/data/db/farming.db')` and calls `policy.s2120UnclaimIdentity`, a plain `SELECT`. A station returns `[null, msg]`, anything else `[msg, null]`. A rejected lookup gives `node.error('S2120 unclaim check failed closed: ' + message, msg)` and `[null, null]`. `finally` awaits `close`; a close error gives `node.warn('S2120 unclaim check DB close failed: ' + message)` after the outcome was chosen, without changing it.

| Condition | Result | Case |
|---|---|---|
| Protected WATERMARK type (all four) | `[msg, null]`, no helper load; dedupe output 3, still no load | G01 |
| Live S2120, non-S2120 device, no usable identity | `[null, msg]`, `[msg, null]`, `[msg, null]`; one open, one close each | G02 |
| Asynchronous open or lookup rejection (the real `osi-db-helper` `Database` reports open failures through its queued queries, `osi-db-helper/index.js:181-205`) | `[null, null]`; error, then close | G02 |
| Close failure after a station lookup; after a lookup failure | outcome kept; warning after close; error before warning | G02 |
| `osi-db-helper` unavailable in the owner gate | one error, `[null, null]`, no open | G03 |
| `osi-irrigation-policy` unavailable at the gate node | one error, `[null, null]`, no DB helper load | G03, T8 |
| `Database` constructor throws synchronously | the constructor runs before the owner gate's `try`, so its promise rejects with that error; no contextual error, no warning, no open, no close, no output. Node-RED's function node reports the rejection itself. | G03 |
| Persistent `osi-command-ledger` load failure, live S2120 | gate output 2; stop at the adapter with `lifecycle command adapter unavailable: <detail>`; no write, no ACK | L01 |
| Persistent `osi-command-ledger` load failure, other device | gate output 1; stop at dedupe with `Command helpers unavailable: <detail>`; no write, no ACK | L02 |

## 5. Exact edit inventory

Plan commit (two paths): `docs/superpowers/plans/issue-233-exact-plan.md` (a byte copy of this file) and `scripts/verify-doc-hygiene-allowlist.json` (one added entry, below).

Stage 1, tests and pinned gates (11 paths): `.github/workflows/migrations.yml`, `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.test.js`, `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.test.js`, `scripts/osi-lib-binding-audit.js`, `scripts/osi-lib-binding-audit.test.js`, `scripts/test-conditional-irrigation-flow.js`, `scripts/test-flows-wiring.js`, `scripts/test-issue-233-weather-detach.js`, `scripts/test-outbox-retry-backoff.js`, `scripts/test-valve-command-safety-path.js`, `scripts/verify-sync-flow.js`.

Stage 2, product (8 paths): `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`, `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/lifecycle.js`, `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.js`, `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/routes.js`, `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/lifecycle.js`, `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.js`, `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/routes.js`.

The doc-hygiene allowlist entry the plan commit adds, at its sorted position. `max` is the exact number of sixteen-digit hex tokens in this file that `verify-doc-hygiene.js` does not treat as example values: six occurrences of the two Node-RED node ids in T1 and T2. The fixture's station and gateway constants are on the checker's example list.

[[PLAN-HYGIENE]]
~~~json
{
  "path": "docs/superpowers/plans/issue-233-exact-plan.md",
  "max": 6,
  "reason": "Node-RED node ids quoted in the issue 233 exact plan wiring hunks; the EUI pattern cannot tell them apart",
  "issue": 233
}
~~~

## 6. Product text: lifecycle.js (both profiles, identical bytes)

Hunks L1 to L7 are the accepted U hunks, unchanged. Each BEFORE text occurs once in B's file.

[[L1-before]]
~~~js
const policyStore = require('./store');
~~~

[[L1-after]]
~~~js
const policyStore = require('./store');
const crypto = require('node:crypto');
~~~

[[L2-before]]
~~~js
  'device_assign', 'device_unassign', 'device_unclaim',
]);
~~~

[[L2-after]]
~~~js
  'device_assign', 'device_unassign', 'device_unclaim',
]);

// Issue #233 Phase A (SENSECAP_S2120 weather links). A local zone detach removes the selected
// (station, zone) pair. Only applyS2120CloudUnclaim sets CLOUD_S2120_UNCLAIM, which is not
// exported, so a local DELETE /api/devices/:deveui never gains the all-links cleanup.
const S2120_TYPE = 'SENSECAP_S2120';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const S2120_WEATHER_PAIR = Symbol('s2120WeatherPair');
const CLOUD_S2120_UNCLAIM = Symbol('cloudS2120Unclaim');
~~~

[[L3-before]]
~~~js
    if (operation === 'device_assign') await add(input.zoneId !== undefined ? input.zoneId : (input.zoneUuid || input.zone_uuid));
~~~

[[L3-after]]
~~~js
    if (operation === 'device_assign') await add(input.zoneId !== undefined ? input.zoneId : (input.zoneUuid || input.zone_uuid));
    if (operation === 'device_unassign' && input[S2120_WEATHER_PAIR] === true) await add(input.zoneId);
~~~

[[L4-before]]
~~~js
  if (operation === 'device_unassign' && input.zoneId != null && Number(current.irrigation_zone_id) !== Number(input.zoneId)) {
~~~

[[L4-after]]
~~~js
  if (operation === 'device_unassign' && input[S2120_WEATHER_PAIR] === true) {
    return detachS2120WeatherPairTx(tx, input, current, discovered, at);
  }
  if (operation === 'device_unassign' && input.zoneId != null && Number(current.irrigation_zone_id) !== Number(input.zoneId)) {
~~~

[[L5-before]]
~~~js
    await tx.run(`UPDATE devices SET ${fields}, updated_at=?, sync_version=? WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL`, params);
~~~

[[L5-after]]
~~~js
    if (operation === 'device_unclaim' && input[CLOUD_S2120_UNCLAIM] === true) await clearCloudS2120WeatherLinksTx(tx, current, at, input.gatewayDeviceEui);
    await tx.run(`UPDATE devices SET ${fields}, updated_at=?, sync_version=? WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL`, params);
~~~

[[L6-before]]
~~~js
async function applyLegacyWriteTx(tx, input = {}) {
~~~

[[L6-after]]
~~~js
// Issue #233 Phase A helpers. tx.run resolves undefined on the production facade, so every
// write below is proven by a read inside the same BEGIN IMMEDIATE transaction.
function s2120Error(status, code, text) {
  return lifecycleError(status, code, code + ': ' + text);
}

function s2120Eui(value) {
  const result = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return EUI_RE.test(result) ? result : null;
}

function s2120OptionalGateway(value) {
  if (value == null || String(value).trim() === '') return null;
  const result = s2120Eui(String(value));
  if (!result) throw s2120Error(409, 'invalid_gateway_binding', 'a stored gateway binding is not a 16-hex EUI');
  return result;
}

function s2120Version(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw s2120Error(409, 'invalid_version', 'a stored sync version is not a safe non-negative integer');
  return value;
}

function s2120Next(value) {
  const current = s2120Version(value);
  if (current >= Number.MAX_SAFE_INTEGER) throw s2120Error(409, 'version_overflow', 'the sync version cannot advance');
  return current + 1;
}

function s2120Nullable(value) {
  return value == null ? null : Number(value);
}

async function s2120GatewayContextTx(tx, device, zones, runtimeGatewayEui) {
  const link = await tx.get("SELECT linked, gateway_device_eui FROM sync_link_state WHERE peer_node='cloud'", []);
  const linked = Boolean(link) && Number(link.linked) === 1;
  const runtime = s2120Eui(runtimeGatewayEui);
  if (linked && !runtime) throw s2120Error(503, 'runtime_gateway_unavailable', 'the trusted gateway identity is unavailable');
  const linkGateway = s2120OptionalGateway(link && link.gateway_device_eui);
  if (linked && linkGateway && linkGateway !== runtime) throw s2120Error(503, 'link_gateway_transition', 'the gateway identity is changing');
  const deviceGateway = s2120OptionalGateway(device.gateway_device_eui);
  if (deviceGateway && runtime && deviceGateway !== runtime) throw s2120Error(409, 'device_gateway_mismatch', 'the station belongs to another gateway');
  for (const zone of zones) {
    const zoneGateway = s2120OptionalGateway(zone.gateway_device_eui);
    if (zoneGateway && runtime && zoneGateway !== runtime) throw s2120Error(409, 'zone_gateway_mismatch', 'the zone belongs to another gateway');
    if (!runtime && deviceGateway && zoneGateway && deviceGateway !== zoneGateway) throw s2120Error(409, 'zone_gateway_mismatch', 'the zone belongs to another gateway');
  }
  return { linked, runtime, deviceGateway };
}

async function s2120BindGatewayTx(tx, device, runtime) {
  await tx.run(
    "UPDATE devices SET gateway_device_eui=? WHERE deveui=? AND (gateway_device_eui IS NULL OR trim(gateway_device_eui)='') AND deleted_at IS NULL",
    [runtime, device.deveui]
  );
  const bound = await tx.get('SELECT gateway_device_eui FROM devices WHERE deveui=?', [device.deveui]);
  if (!bound || s2120Eui(bound.gateway_device_eui) !== runtime) throw s2120Error(500, 'gateway_postcondition_failed', 'the station gateway binding did not persist');
}

async function s2120BumpWeatherTx(tx, deveui, oldState, at) {
  if (!oldState) {
    await tx.run(
      'INSERT INTO weather_station_zone_state(deveui,sync_version,last_applied_at,updated_at) VALUES (?,0,NULL,?)',
      [deveui, at]
    );
    return 1;
  }
  const target = s2120Next(Number(oldState.sync_version));
  await tx.run(
    'UPDATE weather_station_zone_state SET sync_version=?,last_applied_at=NULL,updated_at=? WHERE deveui=? AND sync_version=?',
    [target, at, deveui, oldState.sync_version]
  );
  return target;
}

async function s2120OutboxAfterTx(tx, start, deveui) {
  return tx.all('SELECT rowid, op, payload_json FROM sync_outbox WHERE rowid>? AND aggregate_key=? ORDER BY rowid', [start, deveui]);
}

async function detachS2120WeatherPairTx(tx, input, current, discovered, at) {
  const deviceEui = String(current.deveui);
  if (String(current.type_id || '').toUpperCase() !== S2120_TYPE) throw s2120Error(404, 'device_not_found', 'the device is not a weather station');
  const zoneId = Number(input.zoneId);
  if (!Number.isSafeInteger(zoneId) || zoneId <= 0) throw s2120Error(400, 'invalid_zone_id', 'the zone id must be a positive integer');
  const zone = await tx.get('SELECT id, zone_uuid, gateway_device_eui FROM irrigation_zones WHERE id=? AND deleted_at IS NULL', [zoneId]);
  if (!zone || !UUID_RE.test(String(zone.zone_uuid || ''))) throw s2120Error(404, 'zone_not_found', 'the zone does not exist');
  const pair = await tx.get('SELECT 1 AS present FROM weather_station_zones WHERE deveui=? AND zone_id=?', [deviceEui, zoneId]);
  const primary = current.irrigation_zone_id != null && Number(current.irrigation_zone_id) === zoneId;
  if (!pair && !primary) throw s2120Error(404, 'device_not_found', 'the station is not assigned to this zone');
  const gateway = await s2120GatewayContextTx(tx, current, [zone], input.runtimeGatewayEui);
  const oldVersion = s2120Version(Number(current.sync_version == null ? 0 : current.sync_version));
  const state = await tx.get('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?', [deviceEui]);
  if (state) s2120Version(Number(state.sync_version));
  if (gateway.linked && !gateway.deviceGateway) await s2120BindGatewayTx(tx, current, gateway.runtime);
  // The station leaves the selected zone, so that zone's policy work matches a primary detach.
  // When the primary is a different zone the station stays there and that zone gets none.
  const selectedState = discovered.states.find((item) => Number(item.zone.id) === zoneId) || null;
  const changedPolicy = [];
  const retiredByEui = new Map();
  if (selectedState && selectedState.policy && affectedPoliciesForDevice(selectedState, deviceEui, 'device_unassign').length) {
    await pausePolicyTx(tx, selectedState.policy, at, 'source_removed');
    changedPolicy.push(selectedState.policy.policy_uuid);
    for (const row of selectedState.schedules.filter((item) => item.condition_policy_uuid === selectedState.policy.policy_uuid)) {
      const key = String(row.device_eui).toUpperCase();
      const list = retiredByEui.get(key) || [];
      list.push(row);
      retiredByEui.set(key, list);
    }
  }
  const start = await tx.get('SELECT COALESCE(MAX(rowid),0) AS n FROM sync_outbox', []);
  if (pair) await tx.run('DELETE FROM weather_station_zones WHERE deveui=? AND zone_id=?', [deviceEui, zoneId]);
  const deviceVersion = primary ? s2120Next(oldVersion) : oldVersion;
  if (primary) {
    await tx.run(
      'UPDATE devices SET irrigation_zone_id=NULL, sync_version=?, updated_at=? WHERE deveui=? AND COALESCE(sync_version,0)=? AND irrigation_zone_id=? AND deleted_at IS NULL',
      [deviceVersion, at, deviceEui, oldVersion, zoneId]
    );
  }
  const weatherVersion = pair ? await s2120BumpWeatherTx(tx, deviceEui, state, at) : (state ? Number(state.sync_version) : 0);
  const after = await tx.get('SELECT * FROM devices WHERE deveui=? AND deleted_at IS NULL', [deviceEui]);
  const stillPaired = await tx.get('SELECT 1 AS present FROM weather_station_zones WHERE deveui=? AND zone_id=?', [deviceEui, zoneId]);
  const remaining = await tx.all(
    'SELECT wsz.zone_id, iz.zone_uuid FROM weather_station_zones wsz JOIN irrigation_zones iz ON iz.id=wsz.zone_id WHERE wsz.deveui=? AND iz.deleted_at IS NULL ORDER BY iz.zone_uuid',
    [deviceEui]
  );
  const afterState = await tx.get('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?', [deviceEui]);
  if (!after || Number(after.sync_version) !== deviceVersion || stillPaired ||
      s2120Nullable(after.irrigation_zone_id) !== (primary ? null : s2120Nullable(current.irrigation_zone_id)) ||
      Number(afterState ? afterState.sync_version : 0) !== weatherVersion) {
    throw s2120Error(500, 'detach_postcondition_failed', 'the selected weather pair detach did not persist');
  }
  const emitted = await s2120OutboxAfterTx(tx, start.n, deviceEui);
  const weather = emitted.filter((row) => row.op === 'WEATHER_STATION_ZONES_REPLACED');
  if (weather.length !== (pair && gateway.linked ? 1 : 0)) {
    throw s2120Error(500, 'weather_outbox_postcondition_failed', 'the weather set event count is wrong');
  }
  if (weather.length && JSON.stringify(JSON.parse(weather[0].payload_json).zone_uuids) !== JSON.stringify(remaining.map((row) => row.zone_uuid))) {
    throw s2120Error(500, 'weather_set_postcondition_failed', 'the weather set event does not list the remaining zones');
  }
  const clears = [];
  for (const [valveEui, rows] of retiredByEui) {
    const valve = await tx.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?)', [valveEui]);
    if (!valve || String(valve.type_id).toUpperCase() !== 'STREGA_VALVE') continue;
    const policy = await tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [selectedState.policy.policy_uuid]);
    const prepared = await prepareValveClearTx(tx, valveEui, at, { retiredSchedules: rows, policy });
    if (prepared) clears.push({ device_eui: valveEui, ...prepared });
  }
  return {
    device: after,
    changed_policies: changedPolicy,
    clears,
    schedules_cleared: 0,
    valve_euis: uniqueEuis([deviceEui].concat(discovered.states.flatMap(stateValveEuis))),
    weather_pair: {
      zone_id: zoneId,
      primary_cleared: primary,
      weather_sync_version: weatherVersion,
      zone_uuids: remaining.map((row) => row.zone_uuid),
    },
  };
}

// Runs only for the trusted cloud path (CLOUD_S2120_UNCLAIM), inside its device_unclaim
// transaction and before the device UPDATE, so the empty weather set event precedes
// DEVICE_UNCLAIMED while the station is still claimed and gateway-bound.
async function clearCloudS2120WeatherLinksTx(tx, current, at, gatewayDeviceEui) {
  if (String(current.type_id || '').toUpperCase() !== S2120_TYPE) throw s2120Error(409, 'device_type_changed', 'the cloud weather unclaim needs a weather station');
  const deviceEui = String(current.deveui);
  const runtime = s2120Eui(gatewayDeviceEui);
  if (!runtime) throw s2120Error(503, 'runtime_gateway_unavailable', 'the trusted gateway identity is unavailable');
  if (!s2120OptionalGateway(current.gateway_device_eui)) await s2120BindGatewayTx(tx, current, runtime);
  const links = await tx.all('SELECT zone_id FROM weather_station_zones WHERE deveui=?', [deviceEui]);
  if (!links.length) return;
  const state = await tx.get('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?', [deviceEui]);
  if (state) s2120Version(Number(state.sync_version));
  await tx.run('DELETE FROM weather_station_zones WHERE deveui=?', [deviceEui]);
  const weatherVersion = await s2120BumpWeatherTx(tx, deviceEui, state, at);
  const left = await tx.get('SELECT COUNT(*) AS n FROM weather_station_zones WHERE deveui=?', [deviceEui]);
  const afterState = await tx.get('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?', [deviceEui]);
  if (!left || Number(left.n) !== 0 || !afterState || Number(afterState.sync_version) !== weatherVersion) {
    throw s2120Error(500, 'weather_postcondition_failed', 'the cloud weather unclaim did not clear every link');
  }
}

function s2120Sorted(value) {
  if (Array.isArray(value)) return value.map(s2120Sorted);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = s2120Sorted(value[key] === undefined ? null : value[key]);
      return out;
    }, {});
  }
  return value === undefined ? null : value;
}

function s2120BindingHash(envelope, gateway) {
  const bound = {
    commandId: envelope.commandId,
    eventUuid: envelope.eventUuid,
    commandType: envelope.commandType,
    aggregateType: envelope.aggregateType,
    aggregateKey: envelope.aggregateKey,
    appliedSyncVersion: envelope.appliedSyncVersion,
    effectKey: envelope.effectKey,
    leasedToGateway: envelope.leasedToGateway,
    payload: envelope.payload,
    runtimeGatewayDeviceEui: gateway,
  };
  return crypto.createHash('sha256').update(JSON.stringify(s2120Sorted(bound))).digest('hex');
}

// The legacy camelCase contract the server issues (DeviceController): exactly deviceEui,
// gatewayDeviceEui and syncVersion, optionally commandType UNCLAIM_DEVICE.
function s2120ParseLegacy(envelope, gateway, deviceEui) {
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw s2120Error(400, 'malformed_command', 'the payload is not an object');
  if (!Number.isSafeInteger(payload.syncVersion) || payload.syncVersion <= 0) throw s2120Error(400, 'invalid_version', 'syncVersion must be a positive safe integer');
  const allowed = new Set(['deviceEui', 'gatewayDeviceEui', 'syncVersion', 'commandType']);
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);
  if (Object.keys(payload).some((key) => !allowed.has(key)) ||
      !['deviceEui', 'gatewayDeviceEui', 'syncVersion'].every(has) ||
      (has('commandType') && payload.commandType !== 'UNCLAIM_DEVICE') ||
      s2120Eui(payload.deviceEui) !== deviceEui ||
      s2120Eui(payload.gatewayDeviceEui) !== gateway ||
      envelope.commandType !== 'UNCLAIM_DEVICE' ||
      envelope.aggregateType !== 'DEVICE' ||
      s2120Eui(envelope.aggregateKey) !== deviceEui ||
      typeof envelope.eventUuid !== 'string' || !UUID_RE.test(envelope.eventUuid) ||
      envelope.effectKey != null ||
      envelope.appliedSyncVersion !== payload.syncVersion) {
    throw s2120Error(400, 'malformed_command', 'the S2120 unclaim command does not match the legacy contract');
  }
  return payload.syncVersion;
}

function s2120Ack(ctx, result, version, code, duplicate, cleanup) {
  const envelope = ctx.envelope;
  const aggregateKey = s2120Eui(envelope.aggregateKey) === ctx.deviceEui ? envelope.aggregateKey : null;
  return {
    commandId: envelope.commandId,
    status: result === 'APPLIED' ? 'ACKED' : (result === 'CONFLICT' ? 'CONFLICT' : 'NACKED'),
    result,
    appliedAt: ctx.at,
    appliedSyncVersion: version,
    duplicate: duplicate === true,
    reason: code,
    detail: null,
    eventUuid: typeof envelope.eventUuid === 'string' && UUID_RE.test(envelope.eventUuid) ? envelope.eventUuid : null,
    commandType: envelope.commandType === 'UNCLAIM_DEVICE' ? 'UNCLAIM_DEVICE' : null,
    aggregateType: envelope.aggregateType === 'DEVICE' ? 'DEVICE' : null,
    aggregateKey,
    effectKey: null,
    gatewayDeviceEui: ctx.gateway,
    resourceUuid: aggregateKey,
    payloadHash: null,
    reasonCode: code,
    valveCleanup: cleanup,
  };
}

// One pending REST ACK per command id, byte-identical to the stored decision. A different or
// second pending row is never deleted or replaced: it fails closed.
async function s2120QueueAckTx(tx, commandId, raw, createdAt) {
  const id = String(commandId);
  const pending = await tx.all('SELECT id, payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL', [id]);
  if (pending.length > 1 || (pending.length === 1 && pending[0].payload_json !== raw)) {
    throw s2120Error(500, 'ack_outbox_binding_conflict', 'another pending ACK exists for this command');
  }
  if (pending.length) return;
  await tx.run('INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)', [id, raw, createdAt]);
  const queued = await tx.all('SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL', [id]);
  if (queued.length !== 1 || queued[0].payload_json !== raw) throw s2120Error(500, 'ack_outbox_postcondition_failed', 'the pending ACK did not persist');
}

async function s2120TerminalTx(tx, ctx, result, version, code, duplicate, cleanup) {
  const ack = s2120Ack(ctx, result, version, code, duplicate, cleanup);
  const raw = JSON.stringify(ack);
  const id = String(ctx.envelope.commandId);
  await tx.run(
    'INSERT INTO applied_commands(command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator,binding_hash,resource_type,resource_id,gateway_device_eui) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, ctx.deviceEui, 'UNCLAIM_DEVICE', null, ack.appliedAt, result, raw, 'cloud', ctx.hash, 'DEVICE', ctx.deviceEui, ctx.gateway]
  );
  const stored = await tx.get('SELECT result_detail, binding_hash FROM applied_commands WHERE command_id=?', [id]);
  if (!stored || stored.result_detail !== raw || stored.binding_hash !== ctx.hash) throw s2120Error(500, 'ledger_postcondition_failed', 'the terminal decision did not persist');
  await s2120QueueAckTx(tx, ctx.envelope.commandId, raw, ack.appliedAt);
  return { ack, clears: [] };
}

// Classifies both identities of a cloud UNCLAIM_DEVICE. A disagreement is handled as a
// malformed S2120 command, never passed to the generic path.
async function s2120UnclaimIdentity(db, envelope) {
  const payload = envelope && envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload) ? envelope.payload : {};
  const fromPayload = s2120Eui(payload.deviceEui);
  const candidates = [...new Set([s2120Eui(envelope && envelope.aggregateKey), fromPayload].filter(Boolean))];
  if (!candidates.length) return { station: null, userId: null };
  const rows = await db.all(
    'SELECT UPPER(deveui) AS deveui, type_id, user_id FROM devices WHERE deleted_at IS NULL AND UPPER(deveui) IN (' + candidates.map(() => '?').join(',') + ')',
    candidates
  );
  const stations = rows.filter((row) => String(row.type_id || '').toUpperCase() === S2120_TYPE);
  if (!stations.length) return { station: null, userId: null };
  const chosen = stations.find((row) => row.deveui === fromPayload) || stations[0];
  return { station: chosen.deveui, userId: chosen.user_id == null ? null : chosen.user_id };
}

async function s2120CloudUnclaimTx(tx, ctx) {
  const { envelope, gateway, deviceEui, hash } = ctx;
  const link = await tx.get("SELECT linked, gateway_device_eui FROM sync_link_state WHERE peer_node='cloud'", []);
  if (!link || Number(link.linked) !== 1) return { hold: 'link_inactive' };
  const linkGateway = link.gateway_device_eui == null ? '' : String(link.gateway_device_eui).trim();
  if (linkGateway !== '' && s2120Eui(linkGateway) !== gateway) return { hold: 'link_gateway_transition' };
  try {
    await assertLinkFence(tx);
  } catch (error) {
    if (error && error.code === 'link_in_progress') return { hold: 'link_in_progress' };
    throw error;
  }
  const prior = await tx.get(
    'SELECT command_id, device_eui, command_type, originator, binding_hash, gateway_device_eui, result_detail FROM applied_commands WHERE command_id=?',
    [String(envelope.commandId)]
  );
  if (prior) {
    if (prior.command_type !== 'UNCLAIM_DEVICE' || prior.originator !== 'cloud' ||
        prior.device_eui !== deviceEui || prior.gateway_device_eui !== gateway ||
        prior.binding_hash !== hash) {
      throw s2120Error(409, 'command_id_binding_conflict', 'this command id is bound to a different decision');
    }
    let stored;
    try {
      stored = JSON.parse(prior.result_detail);
    } catch (parseError) {
      throw s2120Error(409, 'command_id_binding_conflict', 'the stored decision is unreadable: ' + String(parseError && parseError.message || parseError));
    }
    if (!stored || stored.commandId !== envelope.commandId || stored.commandType !== 'UNCLAIM_DEVICE' ||
        (stored.aggregateKey !== null && stored.aggregateKey !== envelope.aggregateKey) ||
        (stored.eventUuid !== null && stored.eventUuid !== envelope.eventUuid)) {
      throw s2120Error(409, 'command_id_binding_conflict', 'the stored decision names another command');
    }
    await s2120QueueAckTx(tx, envelope.commandId, prior.result_detail, ctx.at);
    return { ack: stored, replay: true, clears: [] };
  }
  const device = await tx.get(
    'SELECT deveui, type_id, user_id, irrigation_zone_id, sync_version, gateway_device_eui FROM devices WHERE UPPER(deveui)=? AND deleted_at IS NULL',
    [deviceEui]
  );
  if (!device || String(device.type_id || '').toUpperCase() !== S2120_TYPE) return { hold: 'type_changed_or_missing' };
  const terminal = (result, version, code, duplicate, cleanup) => s2120TerminalTx(tx, ctx, result, version, code, duplicate, cleanup);
  const refused = (code) => unclaimValveCleanup({ deviceEui, refused: { code } });
  let current;
  try {
    current = s2120Version(Number(device.sync_version == null ? 0 : device.sync_version));
  } catch (error) {
    return terminal('REJECTED_PERMANENT', 0, 'invalid_version', false, refused('invalid_version'));
  }
  let target;
  try {
    target = s2120ParseLegacy(envelope, gateway, deviceEui);
  } catch (error) {
    if (!error || !['malformed_command', 'invalid_version'].includes(error.code)) throw error;
    return terminal('REJECTED_PERMANENT', current, error.code, false, refused(error.code));
  }
  const zones = await tx.all(
    'SELECT wsz.zone_id, iz.zone_uuid, iz.gateway_device_eui, iz.deleted_at FROM weather_station_zones wsz LEFT JOIN irrigation_zones iz ON iz.id=wsz.zone_id WHERE wsz.deveui=? ORDER BY wsz.zone_id',
    [device.deveui]
  );
  try {
    const deviceGateway = s2120OptionalGateway(device.gateway_device_eui);
    if (deviceGateway && deviceGateway !== gateway) throw s2120Error(409, 'device_gateway_mismatch', 'the station belongs to another gateway');
    for (const zone of zones) {
      const zoneGateway = s2120OptionalGateway(zone.gateway_device_eui);
      if (zoneGateway && zoneGateway !== gateway) throw s2120Error(409, 'zone_gateway_mismatch', 'a linked zone belongs to another gateway');
    }
  } catch (error) {
    if (!error || !['invalid_gateway_binding', 'device_gateway_mismatch', 'zone_gateway_mismatch'].includes(error.code)) throw error;
    return terminal('CONFLICT', current, error.code, false, refused(error.code));
  }
  if (target < current) return terminal('CONFLICT', current, 'stale_sync_version', false, refused('stale_sync_version'));
  if (target === current) {
    const complete = device.user_id == null && device.irrigation_zone_id == null && zones.length === 0;
    return complete
      ? terminal('APPLIED', current, null, true, unclaimValveCleanup({ deviceEui, mutation: { device } }))
      : terminal('CONFLICT', current, 'equal_version_postcondition_failed', false, refused('equal_version_postcondition_failed'));
  }
  if (current >= Number.MAX_SAFE_INTEGER || target !== current + 1) return terminal('CONFLICT', current, 'version_gap', false, refused('version_gap'));
  if (device.user_id == null) {
    const code = zones.length || device.irrigation_zone_id != null ? 'orphaned_weather_links' : 'version_gap';
    return terminal('CONFLICT', current, code, false, refused(code));
  }
  if (ctx.expectedUserId == null || Number(ctx.expectedUserId) !== Number(device.user_id)) {
    return terminal('CONFLICT', current, 'stale_device_state', false, refused('stale_device_state'));
  }
  const start = await tx.get('SELECT COALESCE(MAX(rowid),0) AS n FROM sync_outbox', []);
  const input = Object.assign({}, ctx.input, { syncVersion: target });
  const held = await discoverAffectedWriters(tx, 'device_unclaim', input);
  assertHeld(ctx.heldValveEuis, held.valveEuis, 'device_unclaim');
  const mutation = await applyLifecycleMutationTx(tx, 'device_unclaim', input);
  const post = await discoverAffectedWriters(tx, 'device_unclaim', input);
  assertHeld(ctx.heldValveEuis, post.valveEuis, 'device_unclaim');
  const after = await tx.get('SELECT user_id, irrigation_zone_id, sync_version FROM devices WHERE deveui=? AND deleted_at IS NULL', [device.deveui]);
  const left = await tx.get('SELECT COUNT(*) AS n FROM weather_station_zones WHERE deveui=?', [device.deveui]);
  if (!after || after.user_id != null || after.irrigation_zone_id != null ||
      Number(after.sync_version) !== target || !left || Number(left.n) !== 0) {
    throw s2120Error(500, 'unclaim_postcondition_failed', 'the cloud unclaim did not persist');
  }
  const emitted = await s2120OutboxAfterTx(tx, start.n, device.deveui);
  const weather = emitted.filter((row) => row.op === 'WEATHER_STATION_ZONES_REPLACED');
  const unclaimed = emitted.filter((row) => row.op === 'DEVICE_UNCLAIMED');
  if (weather.length !== (zones.length ? 1 : 0) || unclaimed.length !== 1 ||
      (weather.length && weather[0].rowid >= unclaimed[0].rowid) ||
      (weather.length && JSON.stringify(JSON.parse(weather[0].payload_json).zone_uuids) !== '[]')) {
    throw s2120Error(500, 'unclaim_outbox_postcondition_failed', 'the empty weather set must precede DEVICE_UNCLAIMED');
  }
  const done = await terminal('APPLIED', target, null, false, unclaimValveCleanup({ deviceEui, mutation }));
  return { ack: done.ack, clears: mutation.clears || [] };
}

// Issue #233 Phase A: the cloud UNCLAIM_DEVICE of a SENSECAP_S2120. Holds return { hold } and
// write nothing; a terminal decision returns { ack } after its COMMIT. It never answers
// FAILED_RETRYABLE: the server makes the fifth retryable answer for this unprotected command
// terminal, so a transient state must not consume that budget.
async function applyS2120CloudUnclaim(options = {}) {
  const db = options.db;
  if (!db || typeof db.transaction !== 'function') throw new TypeError('applyS2120CloudUnclaim requires a transactional db facade');
  const envelope = options.envelope && typeof options.envelope === 'object' && !Array.isArray(options.envelope) ? options.envelope : null;
  if (!envelope || !Number.isSafeInteger(envelope.commandId) || envelope.commandId <= 0) return { hold: 'invalid_command_id' };
  const gateway = s2120Eui(options.runtimeGatewayEui);
  const lease = s2120Eui(envelope.leasedToGateway);
  if (!gateway || !lease || lease !== gateway) return { hold: 'lease_gateway_unavailable_or_mismatch' };
  const payload = envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload) ? envelope.payload : {};
  const deviceEui = s2120Eui(options.stationEui);
  if (!deviceEui || (deviceEui !== s2120Eui(envelope.aggregateKey) && deviceEui !== s2120Eui(payload.deviceEui))) return { hold: 'unidentifiable_device' };
  const at = instant(options.now);
  const input = { deviceEui, gatewayDeviceEui: gateway, now: at, [CLOUD_S2120_UNCLAIM]: true };
  const ctx = { envelope, gateway, deviceEui, hash: s2120BindingHash(envelope, gateway), at, input, expectedUserId: options.expectedUserId };
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const discovered = await discoverAffectedWriters(db, 'device_unclaim', input);
    try {
      return await dispatch.withValveWriters(discovered.valveEuis, async () => {
        const outcome = await db.transaction((tx) => s2120CloudUnclaimTx(tx, Object.assign({}, ctx, { heldValveEuis: discovered.valveEuis })));
        if (outcome.hold) return outcome;
        const clearResults = outcome.clears && outcome.clears.length
          ? await sendClears(db, outcome.clears, { transport: options.transport, warn: options.warn }, at)
          : [];
        return { ack: outcome.ack, gateway, replay: outcome.replay === true, clear_results: clearResults };
      });
    } catch (error) {
      if (error && error.code === 'membership_drift') continue;
      throw error;
    }
  }
  return { hold: 'membership_drift' };
}

async function applyLegacyWriteTx(tx, input = {}) {
~~~

[[L7-before]]
~~~js
module.exports = {
  OPERATIONS,
~~~

[[L7-after]]
~~~js
module.exports = {
  OPERATIONS,
  S2120_WEATHER_PAIR,
  s2120UnclaimIdentity,
  applyS2120CloudUnclaim,
~~~

## 7. Product text: routes.js (both profiles, identical bytes)

R1 to R4 are the accepted U hunks, unchanged. R5 adds the owner gate before the export line and exports it.

[[R1-before]]
~~~js
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
  const lifecycleLoad = osiLib.require('osi-irrigation-policy');
  if (!lifecycleLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  const lifecycleResult = await lifecycleLoad.value.applyLifecycleMutation({
    db,
    operation: 'device_unassign',
~~~

[[R1-after]]
~~~js
  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });
  const lifecycleLoad = osiLib.require('osi-irrigation-policy');
  if (!lifecycleLoad.ok) throw Object.assign(new Error('conditional lifecycle service unavailable'), { statusCode: 503 });
  // Issue #233: an S2120 leaves the selected zone's weather pair, not only the primary field.
  // The same grants are re-read inside the lifecycle transaction (fresh role, selected-zone
  // grant, the #404 weather-device access rule); no owner equality is added.
  const weatherKind = await db.get('SELECT type_id FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [deveui]);
  const s2120Pair = Boolean(weatherKind) && String(weatherKind.type_id || '').toUpperCase() === 'SENSECAP_S2120';
  const s2120Options = s2120Pair ? {
    [lifecycleLoad.value.S2120_WEATHER_PAIR]: true,
    runtimeGatewayEui: env.get('DEVICE_EUI'),
    authorizeTx: async function(tx) {
      const txActor = await tx.get('SELECT user_uuid, role FROM users WHERE id=? AND username=? LIMIT 1', [actor.id, auth.username]);
      if (!txActor || !txActor.user_uuid) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      const txRole = await scope.assertFreshRole(tx, txActor.user_uuid, txActor.role, { scopedMode: true });
      if (!scope.canMutate(txRole.role)) throw Object.assign(new Error('insufficient role'), { statusCode: 403 });
      const txZone = await tx.get('SELECT zone_uuid FROM irrigation_zones WHERE id=? AND deleted_at IS NULL', [zoneId]);
      if (!txZone || !txZone.zone_uuid) throw Object.assign(new Error('zone not found'), { statusCode: 404 });
      await scope.assertFreshZoneAccess(tx, txActor.user_uuid, txZone.zone_uuid, { scopedMode: true });
      await scope.assertFreshDeviceAccess(tx, txActor.user_uuid, deveui, { scopedMode: true });
    },
  } : {};
  const lifecycleResult = await lifecycleLoad.value.applyLifecycleMutation({
    ...s2120Options,
    db,
    operation: 'device_unassign',
~~~

[[R2-before]]
~~~js
  msg.payload = { message: 'Device removed from zone successfully', deveui, irrigation_zone_id: null, gateway_device_eui: unassigned && unassigned.gateway_device_eui || null, sync_version: Number(unassigned && unassigned.sync_version || 0), deleted_at: null, clear_results: lifecycleResult.clear_results || [] };
~~~

[[R2-after]]
~~~js
  msg.payload = { message: 'Device removed from zone successfully', deveui, irrigation_zone_id: s2120Pair && unassigned && unassigned.irrigation_zone_id != null ? Number(unassigned.irrigation_zone_id) : null, gateway_device_eui: unassigned && unassigned.gateway_device_eui || null, sync_version: Number(unassigned && unassigned.sync_version || 0), deleted_at: null, clear_results: lifecycleResult.clear_results || [] };
~~~

[[R3-before]]
~~~js
  const lifecycleResult = await policyLoad.value.applyLifecycleMutation({ db: lifecycleDb, operation: 'device_unassign', deviceEui: deveui, zoneId, actor: { user_id: userId }, requireOwner: true, now: new Date().toISOString() });
  const removed = lifecycleResult.device || await lifecycleDb.get('SELECT gateway_device_eui,sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)', [deveui]);
  msg.statusCode = lifecycleResult.status || 200;
  msg.payload = { message: 'Device removed from zone successfully', deveui, irrigation_zone_id: null, gateway_device_eui: removed && removed.gateway_device_eui || null, sync_version: Number(removed && removed.sync_version || 0), deleted_at: null, clear_results: lifecycleResult.clear_results || [] };
~~~

[[R3-after]]
~~~js
  // Issue #233: flag-off keeps the current device-claim predicate (requireOwner, checked inside
  // the transaction). An S2120 also re-reads the signed live account there and detaches the
  // selected weather pair.
  const weatherKind = await lifecycleDb.get('SELECT type_id FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [deveui]);
  const s2120Pair = Boolean(weatherKind) && String(weatherKind.type_id || '').toUpperCase() === 'SENSECAP_S2120';
  const s2120Options = s2120Pair ? {
    [policyLoad.value.S2120_WEATHER_PAIR]: true,
    runtimeGatewayEui: env.get('DEVICE_EUI'),
    authorizeTx: async function(tx) {
      const live = await tx.get('SELECT id, disabled_at FROM users WHERE id=? AND username=? LIMIT 1', [userId, String(msg.authUsername || '')]);
      if (!live || live.disabled_at) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    },
  } : {};
  const lifecycleResult = await policyLoad.value.applyLifecycleMutation({ ...s2120Options, db: lifecycleDb, operation: 'device_unassign', deviceEui: deveui, zoneId, actor: { user_id: userId }, requireOwner: true, now: new Date().toISOString() });
  const removed = lifecycleResult.device || await lifecycleDb.get('SELECT gateway_device_eui,sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)', [deveui]);
  msg.statusCode = lifecycleResult.status || 200;
  msg.payload = { message: 'Device removed from zone successfully', deveui, irrigation_zone_id: s2120Pair && removed && removed.irrigation_zone_id != null ? Number(removed.irrigation_zone_id) : null, gateway_device_eui: removed && removed.gateway_device_eui || null, sync_version: Number(removed && removed.sync_version || 0), deleted_at: null, clear_results: lifecycleResult.clear_results || [] };
~~~

[[R4-before]]
~~~js
  const supported = new Set(['UPDATE_SCHEDULE', 'UPSERT_SCHEDULE', 'ASSIGN_DEVICE_TO_ZONE', 'REMOVE_DEVICE_FROM_ZONE', 'UNCLAIM_DEVICE']);
  if (!supported.has(commandType)) return [msg, null];
~~~

[[R4-after]]
~~~js
  const supported = new Set(['UPDATE_SCHEDULE', 'UPSERT_SCHEDULE', 'ASSIGN_DEVICE_TO_ZONE', 'REMOVE_DEVICE_FROM_ZONE', 'UNCLAIM_DEVICE']);
  if (!supported.has(commandType)) return [msg, null];
  // Issue #233 Phase A: an UNCLAIM_DEVICE that names a live SENSECAP_S2120 by its outer or raw
  // identity is decided by applyS2120CloudUnclaim. A lease, link or runtime hold sends no ACK;
  // a terminal decision is one bound ledger row and one REST ACK row, committed before this
  // output 2 MQTT copy. It never takes the FAILED_RETRYABLE path below or the generic ACK
  // queue (output 1), which turns CONFLICT into FAILED_RETRYABLE. Other devices keep the
  // unchanged path below.
  if (commandType === 'UNCLAIM_DEVICE') {
    const s2120Db = new dbLoad.value.Database('/data/db/farming.db');
    let s2120Transport = null;
    try {
      const identity = await policyLoad.value.s2120UnclaimIdentity(s2120Db, envelope);
      if (identity.station) {
        s2120Transport = unclaimTransport(typeof chirpstack === 'undefined' ? null : chirpstack, env, osiLib, node);
        const outcome = await policyLoad.value.applyS2120CloudUnclaim({
          db: s2120Db,
          envelope,
          stationEui: identity.station,
          expectedUserId: identity.userId,
          runtimeGatewayEui: env.get('DEVICE_EUI') || env.get('GATEWAY_DEVICE_EUI'),
          transport: s2120Transport,
          warn: (message) => node.warn(String(message)),
        });
        if (outcome.hold) {
          node.warn('S2120 unclaim held, command ' + String(envelope.commandId) + ': ' + outcome.hold);
          return [null, null, null];
        }
        return [null, null, { topic: 'devices/' + outcome.gateway + '/command_ack', payload: JSON.stringify(outcome.ack), qos: 1 }];
      }
    } catch (unclaimError) {
      node.error('S2120 unclaim failed closed without ACK: ' + String(unclaimError && unclaimError.code || 'error') + ': ' + String(unclaimError && unclaimError.message || unclaimError), msg);
      return [null, null, null];
    } finally {
      closeUnclaimTransport(s2120Transport);
      try {
        await new Promise((resolve) => s2120Db.close(() => resolve()));
      } catch (closeError) {
        node.warn('S2120 unclaim DB close failed: ' + String(closeError && closeError.message || closeError));
      }
    }
  }
~~~

[[R5-before]]
~~~js
module.exports = Object.freeze({ scopedZoneDelete, scopedDeviceAssign, scopedDeviceUnassign, scopedDeviceDelete, conditionalLegacySchedule, conditionalLifecycleCommand, conditionalPolicyCommand, zoneDelete, deviceAssign, deviceUnassign, deviceUnclaim });
~~~

[[R5-after]]
~~~js
// Issue #233 Phase A: the S2120 unclaim gate node (s2120-unclaim-gate) hands every cloud
// UNCLAIM_DEVICE here before the generic replay check (command-dedupe-dispatch). The
// pending-command builders set command.leasedToGateway from the cloud response after the raw
// payload, so it is the trusted lease; it joins the protected envelope that
// applyS2120CloudUnclaim binds. A command that names a live SENSECAP_S2120 returns on output 2
// and never reaches the generic replay check, which refuses the bound ledger row of a replay;
// conditionalLifecycleCommand decides it. Anything else returns on output 1. A helper or
// lookup failure fails closed: one node.error, no output and no write.
async function s2120UnclaimGate(context) {
  const { msg, node, osiLib, policy, command, envelope } = context;
  envelope.leasedToGateway = command.leasedToGateway == null ? null : command.leasedToGateway;
  const dbLoad = osiLib.require('osi-db-helper');
  if (!dbLoad.ok) {
    node.error('S2120 unclaim owner unavailable: ' + String(dbLoad.error), msg);
    return [null, null];
  }
  const db = new dbLoad.value.Database('/data/db/farming.db');
  try {
    const identity = await policy.s2120UnclaimIdentity(db, envelope);
    return identity.station ? [null, msg] : [msg, null];
  } catch (error) {
    node.error('S2120 unclaim check failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await new Promise((resolve, reject) => db.close((closeError) => closeError ? reject(closeError) : resolve()));
    } catch (closeError) {
      node.warn('S2120 unclaim check DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
}

module.exports = Object.freeze({ scopedZoneDelete, scopedDeviceAssign, scopedDeviceUnassign, scopedDeviceDelete, conditionalLegacySchedule, conditionalLifecycleCommand, conditionalPolicyCommand, s2120UnclaimGate, zoneDelete, deviceAssign, deviceUnassign, deviceUnclaim });
~~~

## 8. Product text: replication.js (both profiles, identical bytes)

P1 adds `flowPeerDb` before the export object and exports it. It holds no module state; its closures are `q`, `run`, `warn`, `label` and its own `get`. `BEGIN IMMEDIATE` stays outside the `try`, as in the inline objects.

[[P1-before]]
~~~js
module.exports = {
  CONDITIONAL_CAPABILITY,
  readPeerContext,
  peerSupportsConditional,
  beginPeerRequest,
  capturePeerRequest: beginPeerRequest,
  acceptPeerCapabilities,
  invalidatePeerRequest,
~~~

[[P1-after]]
~~~js
// Issue #233: the conditional peer database of a flow node, built over that node's own
// connection. q(sql, params) resolves rows and run(sql, params) executes; the peer verbs above
// use only get and transaction. A transaction runs fn between BEGIN IMMEDIATE and COMMIT. When
// fn or COMMIT throws it rolls back, reports a failed rollback through
// warn(label + ' rollback failed: ...') and rethrows that error.
function flowPeerDb(q, run, warn, label) {
  const get = async (sql, params = []) => (await q(sql, params))[0] || null;
  return {
    get,
    transaction: async (fn) => {
      await run('BEGIN IMMEDIATE');
      const tx = {
        get,
        run: async (sql, params = []) => run(sql, params)
      };
      try {
        const value = await fn(tx);
        await run('COMMIT');
        return value;
      } catch (error) {
        try {
          await run('ROLLBACK');
        } catch (rollbackError) {
          warn(label + ' rollback failed: ' + String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError));
        }
        throw error;
      }
    }
  };
}

module.exports = {
  CONDITIONAL_CAPABILITY,
  readPeerContext,
  peerSupportsConditional,
  beginPeerRequest,
  capturePeerRequest: beginPeerRequest,
  acceptPeerCapabilities,
  invalidatePeerRequest,
  flowPeerDb,
~~~

## 9. Product text: flows.json (both profiles, identical bytes)

G1. A new function node, inserted directly before `command-dedupe-dispatch` in the array: `id` `s2120-unclaim-gate`, `type` `function`, `z` and `x` of the dedupe node, `y` 60 above it, `name` `S2120 Unclaim Owner Gate`, `outputs` 2, `timeout` 0, `noerr` 0, `initialize` and `finalize` empty, `libs` `[{"var":"osiLib","module":"osi-lib"}]`, `wires` `[["command-dedupe-dispatch"],["journal-command-apply-fn"]]`, keys in the dedupe node's order. Its `func`:

[[GATE-FUNC]]
~~~js
// Issue #233 Phase A: every guarded cloud command passes here before the generic replay
// check (output 1). An UNCLAIM_DEVICE goes to the irrigation-policy owner's gate, which adds
// its trusted lease to the envelope and sends one that names a live SENSECAP_S2120 to the
// appliers (output 2). Other commands pass on unchanged and load no helper.
return (async () => {
  let cmd;
  try {
    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
  } catch (parseError) {
    return [msg, null]; // the replay check reports the unreadable payload
  }
  const envelope = cmd && cmd._pendingCommandEnvelope;
  if (!envelope || String(envelope.commandType || '').trim().toUpperCase() !== 'UNCLAIM_DEVICE') return [msg, null];
  const policyLoad = osiLib.require('osi-irrigation-policy');
  if (!policyLoad.ok) {
    node.error('S2120 unclaim owner unavailable: ' + String(policyLoad.error), msg);
    return [null, null];
  }
  return policyLoad.value.routes.s2120UnclaimGate({ msg, node, osiLib, policy: policyLoad.value, command: cmd, envelope });
})();
~~~

G2. `reject-indefinite-open` wires change from `[["command-dedupe-dispatch"],["command-ack-queue-rest"]]` to `[["s2120-unclaim-gate"],["command-ack-queue-rest"]]`.

PEER. Each block below occurs once per node it is applied to: the capture block once in `sync-outbox-build` and once in `sync-force-build`, the capability and invalidation blocks once in `sync-force-build`. The two capture sites keep `conditionalReplication &&`, because the inline object was built even when the helper had not loaded and the next line already short-circuits on a null helper. The capability and invalidation sites run only after a captured request, inside their existing `try`. Every edit lies after the builder's `runGatewayMigrationPreflight` span.

[[PEER-capture-before]]
~~~js
    const peerDb = {
      get: async (sql, params = []) => (await q(sql, params))[0] || null,
      transaction: async (fn) => {
        await run('BEGIN IMMEDIATE');
        const tx = {
          get: async (sql, params = []) => (await q(sql, params))[0] || null,
          run: async (sql, params = []) => run(sql, params)
        };
        try {
          const value = await fn(tx);
          await run('COMMIT');
          return value;
        } catch (error) {
          try { await run('ROLLBACK'); } catch (rollbackError) { node.warn('Peer capture rollback failed: ' + String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError)); }
          throw error;
        }
      }
    };
~~~

[[PEER-capture-after]]
~~~js
    const peerDb = conditionalReplication && conditionalReplication.flowPeerDb(q, run, (text) => node.warn(text), 'Peer capture');
~~~

[[PEER-capability-before]]
~~~js
      const peerDb = {
        get: async (sql, params = []) => (await q(sql, params))[0] || null,
        transaction: async (fn) => {
          await run('BEGIN IMMEDIATE');
          const tx = {
            get: async (sql, params = []) => (await q(sql, params))[0] || null,
            run: async (sql, params = []) => run(sql, params)
          };
          try {
            const value = await fn(tx);
            await run('COMMIT');
            return value;
          } catch (error) {
            try { await run('ROLLBACK'); } catch (rollbackError) { node.warn('Peer capability rollback failed: ' + String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError)); }
            throw error;
          }
        }
      };
~~~

[[PEER-capability-after]]
~~~js
      const peerDb = conditionalReplication.flowPeerDb(q, run, (text) => node.warn(text), 'Peer capability');
~~~

[[PEER-invalidation-before]]
~~~js
      const peerDb = {
        get: async (sql, params = []) => (await q(sql, params))[0] || null,
        transaction: async (fn) => {
          await run('BEGIN IMMEDIATE');
          const tx = {
            get: async (sql, params = []) => (await q(sql, params))[0] || null,
            run: async (sql, params = []) => run(sql, params)
          };
          try {
            const value = await fn(tx);
            await run('COMMIT');
            return value;
          } catch (error) {
            try { await run('ROLLBACK'); } catch (rollbackError) { node.warn('Peer invalidation rollback failed: ' + String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError)); }
            throw error;
          }
        }
      };
~~~

[[PEER-invalidation-after]]
~~~js
      const peerDb = conditionalReplication.flowPeerDb(q, run, (text) => node.warn(text), 'Peer invalidation');
~~~

F4. In `sync-outbox-build` and `sync-force-build`, the one `ORDER BY occurred_at ASC LIMIT 100` becomes `ORDER BY occurred_at ASC, rowid ASC LIMIT 100`. Rowid rises strictly in `sync_outbox`, and the weather state trigger inserts before the device trigger in the same transaction, so equal-millisecond events keep their order at the 100-row cut.

F5. `conditional-lifecycle-command-adapter`: `outputs` 2 to 3, and a third wire to the MQTT ACK node that `weather-zones-command-apply-fn` output 2 already targets. Its function is unchanged.

The size contract replaces the retired allowance. Sizes are UTF-16 code units of `func` plus `initialize` plus `finalize`, the measure `scripts/flows-size-scan.js` uses. The editor recomputes every field from the bytes it builds, compares them with this block, refuses any removed or grown function node and any new node other than the gate, compares every unchanged node as JSON with B, and checks the four preflight spans, the rendered flows digest and the three module digests before it writes.

[[SIZE-CONTRACT]]
~~~json
{
  "baseTotal": 1617691,
  "total": 1616317,
  "baseFunctionNodes": 315,
  "functionNodes": 316,
  "nodes": {
    "command-dedupe-dispatch": {
      "base": 3125,
      "chars": 3125,
      "func": 3125,
      "initialize": 0,
      "finalize": 0,
      "funcSha256": "2eb3841c0c2769e5745af445779a2181a15f74ddc7055cc87da3b2261aa04b23"
    },
    "sync-pending-split": {
      "base": 3282,
      "chars": 3282,
      "func": 3282,
      "initialize": 0,
      "finalize": 0,
      "funcSha256": "fe98eb278fe37a13e28f6166ad25d29ba12b920a569e741472ee17e91c194a06"
    },
    "sync-outbox-build": {
      "base": 26926,
      "chars": 26348,
      "func": 26348,
      "initialize": 0,
      "finalize": 0,
      "funcSha256": "abd3a61fdad2416408d2c90bdd051b66fb9a46499bbaff7239a69deda630a764"
    },
    "sync-force-build": {
      "base": 82239,
      "chars": 80363,
      "func": 80363,
      "initialize": 0,
      "finalize": 0,
      "funcSha256": "b254717fc7e7bfea72a255a9d6a17a43c5e6c371e58617565cf4b85b8a175aea"
    },
    "s2120-unclaim-gate": {
      "base": null,
      "chars": 1080,
      "func": 1080,
      "initialize": 0,
      "finalize": 0,
      "funcSha256": "eb729e540155777de07271c4c7f232de5d997420306ab625c115ff8321413c8f"
    },
    "conditional-lifecycle-command-adapter": {
      "base": 1017,
      "chars": 1017,
      "func": 1017,
      "initialize": 0,
      "finalize": 0,
      "funcSha256": "c27f414f02822db4ceff3a47d669303a11c551e3b67b22550bd7d1ffa883d5ea"
    },
    "reject-indefinite-open": {
      "base": 10705,
      "chars": 10705,
      "func": 10705,
      "initialize": 0,
      "finalize": 0,
      "funcSha256": "d2ffb79b85fd596a8ce57890b4a2c5e8e071dcc2d6cd3ec609e263e53a363829"
    }
  },
  "preflight": {
    "sync-bootstrap-build": {
      "end": "\nfunction normalizeCloudServerUrl",
      "sha256": "9ae98d1f0fba0086ebc1dbe556a58656f7bd52d74b6ca81d085735df3950fe46"
    },
    "sync-outbox-build": {
      "end": "\nfunction normalizeCloudServerUrl",
      "sha256": "abbebaac2e03f06562d6e6c49ff10fbca800c229d8cf5879a9af3ba0a0558c56"
    },
    "sync-pending-build": {
      "end": "\nfunction normalizeCloudServerUrl",
      "sha256": "6f4fbe26fd5954042736f07e05d99c40ffe55ad1bff2a35097c8fec32f49570b"
    },
    "sync-force-build": {
      "end": "\nfunction recordFailure",
      "sha256": "df5cb5ca7dae8dc1bfeba7b8546e1d215ead1f71730f426400bbafb02f07864d"
    }
  },
  "flowsSha256": "bb242d1dadb0634c26cf72e1ef7eeb4af651ded9eb22382bcb32f5275082b41b",
  "modules": {
    "lifecycle.js": "f252abf7c4b18289d013c35c220129f9d32b093ea74fc9a7e5ca8f630ff814d6",
    "routes.js": "53b65daea3267d702a42c86ac2db092989c0444eda453c5d16bcd460e3dd1e97",
    "replication.js": "b8386ee69fcc256ad3b1dd2494f1e0c2a15ca201d0172603b41bc0ec57aa052b"
  }
}
~~~

| Node, per profile | B | Proposed | Delta |
|---|---:|---:|---:|
| `command-dedupe-dispatch` | 3125 | 3125 | +0 |
| `sync-pending-split` | 3282 | 3282 | +0 |
| `sync-outbox-build` | 26926 | 26348 | -578 |
| `sync-force-build` | 82239 | 80363 | -1876 |
| `s2120-unclaim-gate` | absent | 1080 | +1080 |
| `conditional-lifecycle-command-adapter` | 1017 | 1017 | +0 |
| `reject-indefinite-open` | 10705 | 10705 | +0 |
| Total, 315 to 316 function nodes | 1617691 | 1616317 | -1374 |

## 10. Test and gate text (Stage 1)

T1, T2, T3a, T4a, T5 and T6a are the U hunks; T2 adds one console line so that gate 33 shows it reached the outputs and wires assertions in both profiles. T3b, T4b, T6b, T8 and T9 replace the U dedupe pins with gate pins. V1, V2 and RT1 are new inputs.

T1, `scripts/test-flows-wiring.js`:

[[T1-before]]
~~~js
    JSON.stringify(lifecycleCommandAdapter.wires || []) !== JSON.stringify([['4f4a765f36cee6f3'], ['command-ack-queue-rest']])) {
    failures.push('lifecycle command adapter must own schedule/device mutations and durable ACKs before the legacy SQL builder');
} else {
    console.log('OK  lifecycle command adapter delegates canonical mutation and durable ACK atomically');
}
~~~

[[T1-after]]
~~~js
    lifecycleCommandAdapter.outputs !== 3 ||
    JSON.stringify(lifecycleCommandAdapter.wires || []) !== JSON.stringify([['4f4a765f36cee6f3'], ['command-ack-queue-rest'], ['9d5e3035c3d069c4']])) {
    failures.push('lifecycle command adapter must own schedule/device mutations and durable ACKs before the legacy SQL builder, and send its S2120 unclaim ACK (issue #233) to the MQTT ACK node only');
} else {
    console.log('OK  lifecycle command adapter delegates canonical mutation and durable ACK atomically; its S2120 unclaim ACK goes to MQTT only');
}
~~~

T2, `scripts/test-conditional-irrigation-flow.js`:

[[T2-before]]
~~~js
  assert.deepEqual(lifecycleCommand.wires, [['4f4a765f36cee6f3'], ['command-ack-queue-rest']], `${profile}: lifecycle adapter owns raw fallback and durable ACK outputs`);
~~~

[[T2-after]]
~~~js
  assert.equal(lifecycleCommand.outputs, 3, `${profile}: lifecycle adapter has raw fallback, durable ACK and S2120 unclaim ACK outputs`);
  assert.deepEqual(lifecycleCommand.wires, [['4f4a765f36cee6f3'], ['command-ack-queue-rest'], ['9d5e3035c3d069c4']], `${profile}: lifecycle adapter owns raw fallback and durable ACK outputs; its S2120 unclaim ACK goes to MQTT only (issue #233)`);
  console.log(`OK ${profile}: issue 233 lifecycle adapter outputs and wires checked`);
~~~

T3, `scripts/osi-lib-binding-audit.js`. The dedupe entry keeps its B digest and three bindings; the gate entry pins the digest of GATE-FUNC with the one policy binding.

[[T3a-before]]
~~~js
const ENTITY_NAME_BINDING = Object.freeze({ variable: 'entityName', module: 'entity-name' });
~~~

[[T3a-after]]
~~~js
const ENTITY_NAME_BINDING = Object.freeze({ variable: 'entityName', module: 'entity-name' });
const IRRIGATION_POLICY_BINDING = Object.freeze({ variable: 'osiIrrigationPolicy', module: 'osi-irrigation-policy' });
~~~

[[T3b-before]]
~~~js
  'command-dedupe-dispatch': Object.freeze({
    funcSha256: '2eb3841c0c2769e5745af445779a2181a15f74ddc7055cc87da3b2261aa04b23',
    bindings: Object.freeze([DB_BINDING, JOURNAL_BINDING, LEDGER_BINDING]),
  }),
~~~

[[T3b-after]]
~~~js
  'command-dedupe-dispatch': Object.freeze({
    funcSha256: '2eb3841c0c2769e5745af445779a2181a15f74ddc7055cc87da3b2261aa04b23',
    bindings: Object.freeze([DB_BINDING, JOURNAL_BINDING, LEDGER_BINDING]),
  }),
  's2120-unclaim-gate': Object.freeze({
    // Issue #233 Phase A: runs before command-dedupe-dispatch. Only a cloud UNCLAIM_DEVICE loads
    // the irrigation-policy owner (routes.s2120UnclaimGate); every other command loads nothing.
    funcSha256: 'eb729e540155777de07271c4c7f232de5d997420306ab625c115ff8321413c8f',
    bindings: Object.freeze([IRRIGATION_POLICY_BINDING]),
  }),
~~~

T4, `scripts/osi-lib-binding-audit.test.js`:

[[T4a-before]]
~~~js
  entityName: { variable: 'entityName', module: 'entity-name' },
~~~

[[T4a-after]]
~~~js
  entityName: { variable: 'entityName', module: 'entity-name' },
  irrigationPolicy: { variable: 'osiIrrigationPolicy', module: 'osi-irrigation-policy' },
~~~

[[T4b-before]]
~~~js
  'command-dedupe-dispatch': [bindings.db, bindings.journal, bindings.ledger],
~~~

[[T4b-after]]
~~~js
  'command-dedupe-dispatch': [bindings.db, bindings.journal, bindings.ledger],
  's2120-unclaim-gate': [bindings.irrigationPolicy],
~~~

T5, `scripts/test-outbox-retry-backoff.js` (the extracted SELECT must carry the tie-break):

[[T5-before]]
~~~js
"( ORDER BY occurred_at ASC LIMIT 100)"
~~~

[[T5-after]]
~~~js
"( ORDER BY occurred_at ASC, rowid ASC LIMIT 100)"
~~~

T6, `scripts/test-flows-wiring.js`. T6a adds the binding constant; T6b checks the gate's binding, arity, wires, delegation and the guard's wire to it.

[[T6a-before]]
~~~js
const OSI_CHIRPSTACK_BINDING = { variable: 'chirpstack', module: 'chirpstack' };
~~~

[[T6a-after]]
~~~js
const OSI_CHIRPSTACK_BINDING = { variable: 'chirpstack', module: 'chirpstack' };
const OSI_IRRIGATION_POLICY_BINDING = { variable: 'osiIrrigationPolicy', module: 'osi-irrigation-policy' };
~~~

[[T6b-before]]
~~~js
    failures.push('journal commands: dedupe must delegate exact replay via the shared command ledger, fail closed, and bypass ACK reclassification');
}
~~~

[[T6b-after]]
~~~js
    failures.push('journal commands: dedupe must delegate exact replay via the shared command ledger, fail closed, and bypass ACK reclassification');
}
const s2120UnclaimGate = byId['s2120-unclaim-gate'];
if (!s2120UnclaimGate || !requireOsiLibContract(
    s2120UnclaimGate,
    [OSI_IRRIGATION_POLICY_BINDING],
    'S2120 unclaim gate',
    'S2120 unclaim owner unavailable:'
) || s2120UnclaimGate.outputs !== 2 ||
    JSON.stringify(s2120UnclaimGate.wires) !== JSON.stringify([['command-dedupe-dispatch'], ['journal-command-apply-fn']]) ||
    !pendingGuard || JSON.stringify(pendingGuard.wires) !== JSON.stringify([['s2120-unclaim-gate'], ['command-ack-queue-rest']]) ||
    !/routes\.s2120UnclaimGate\(/.test(s2120UnclaimGate.func || '')) {
    failures.push('S2120 unclaim gate: every guarded cloud command must pass the issue #233 owner gate before the generic replay check, and only the owner may send it past that check');
} else {
    console.log('OK  S2120 unclaim gate runs before the generic replay check; only the irrigation-policy owner sends a command past it');
}
~~~

T8, `scripts/test-flows-wiring.js`, the helper-failure matrix: an `UNCLAIM_DEVICE` at the gate loads exactly `osi-irrigation-policy`, reports one contextual error and returns `[null, null]`.

[[T8-before]]
~~~js
        {
            node: dedupe,
            label: 'journal helper failure: dedupe',
            helpers: ['osi-db-helper', 'osi-command-ledger'],
            errorPrefix: 'Command helpers unavailable: ',
            expected: [null, null],
        },
~~~

[[T8-after]]
~~~js
        {
            node: dedupe,
            label: 'journal helper failure: dedupe',
            helpers: ['osi-db-helper', 'osi-command-ledger'],
            errorPrefix: 'Command helpers unavailable: ',
            expected: [null, null],
        },
        {
            node: s2120UnclaimGate,
            label: 'S2120 unclaim helper failure: gate',
            commandType: 'UNCLAIM_DEVICE',
            helpers: ['osi-irrigation-policy'],
            errorPrefix: 'S2120 unclaim owner unavailable: ',
            expected: [null, null],
        },
~~~

T9, `scripts/test-flows-wiring.js`: each builder builds each peer database once per label through `conditionalReplication.flowPeerDb`, and no inline `const peerDb = {` remains.

[[T9-before]]
~~~js
// === Fail-closed sync_outbox payload parsing ===
~~~

[[T9-after]]
~~~js
// Issue #233: both batch builders get their conditional peer database from
// replication.flowPeerDb, and each call keeps its own rollback warning label.
for (const [nodeId, labels] of [
    ['sync-outbox-build', ['Peer capture']],
    ['sync-force-build', ['Peer capture', 'Peer capability', 'Peer invalidation']],
]) {
    const source = (byId[nodeId] || {}).func || '';
    const calls = labels.map((label) => `conditionalReplication.flowPeerDb(q, run, (text) => node.warn(text), '${label}')`);
    if (calls.some((call) => source.split(call).length !== 2) || /const peerDb = \{/.test(source)) {
        failures.push(`conditional peer: ${nodeId} must build each peer database through replication.flowPeerDb with its own rollback label`);
    }
}

// === Fail-closed sync_outbox payload parsing ===
~~~

V1, `scripts/verify-sync-flow.js`, the wire path:

[[V1-before]]
~~~js
expectWireById('reject-indefinite-open', 'command-dedupe-dispatch', 'routes guarded cloud commands through the replay ledger');
~~~

[[V1-after]]
~~~js
expectWireById('reject-indefinite-open', 's2120-unclaim-gate', 'routes guarded cloud commands through the issue #233 S2120 unclaim gate');
expectWireById('s2120-unclaim-gate', 'command-dedupe-dispatch', 'routes guarded cloud commands through the replay ledger');
expectWireById('s2120-unclaim-gate', 'journal-command-apply-fn', 'sends an S2120 unclaim to the appliers, where its irrigation-policy owner keeps the bound replay decision');
~~~

V2, `scripts/test-valve-command-safety-path.js`: the traversal executes the gate instead of stopping at it.

[[V2-before]]
~~~js
  'reject-indefinite-open',
  'command-dedupe-dispatch',
~~~

[[V2-after]]
~~~js
  'reject-indefinite-open',
  's2120-unclaim-gate',
  'command-dedupe-dispatch',
~~~

RT1, appended to both profile copies of `osi-irrigation-policy/replication.test.js` (B ends each with a newline): commit order and value, callback-error rollback without a warning, and a failed COMMIT plus failed ROLLBACK that warns with the label and rethrows the original error. BEGIN failure is not covered.

[[RT1]]
~~~js

test('flowPeerDb runs a transaction over the flow connection and commits it (issue #233)', async () => {
  const calls = [];
  const rows = { 'SELECT 1': [{ one: 1 }] };
  const q = async (sql, params) => { calls.push(['q', sql, params]); return rows[sql] || []; };
  const run = async (sql, params) => { calls.push(['run', sql, params]); };
  const warnings = [];
  const db = replication.flowPeerDb(q, run, (text) => warnings.push(text), 'Peer capture');
  assert.deepEqual(await db.get('SELECT 1'), { one: 1 });
  assert.equal(await db.get('SELECT 2', ['x']), null);
  const value = await db.transaction(async (tx) => {
    assert.deepEqual(await tx.get('SELECT 1', [7]), { one: 1 });
    await tx.run('UPDATE t SET v=?', [1]);
    return 'done';
  });
  assert.equal(value, 'done');
  assert.deepEqual(calls, [
    ['q', 'SELECT 1', []],
    ['q', 'SELECT 2', ['x']],
    ['run', 'BEGIN IMMEDIATE', undefined],
    ['q', 'SELECT 1', [7]],
    ['run', 'UPDATE t SET v=?', [1]],
    ['run', 'COMMIT', undefined],
  ]);
  assert.deepEqual(warnings, []);
});

test('flowPeerDb rolls back a failed transaction and rethrows its error without a warning (issue #233)', async () => {
  const calls = [];
  const warnings = [];
  const failure = new Error('peer write failed');
  const db = replication.flowPeerDb(async () => [], async (sql) => { calls.push(sql); }, (text) => warnings.push(text), 'Peer capture');
  await assert.rejects(db.transaction(async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(calls, ['BEGIN IMMEDIATE', 'ROLLBACK']);
  assert.deepEqual(warnings, []);
});

test('flowPeerDb reports a failed rollback with its label and still rethrows the original error (issue #233)', async () => {
  const calls = [];
  const warnings = [];
  const failure = new Error('commit failed');
  const run = async (sql) => {
    calls.push(sql);
    if (sql === 'COMMIT') throw failure;
    if (sql === 'ROLLBACK') throw new Error('database is locked');
  };
  const db = replication.flowPeerDb(async () => [], run, (text) => warnings.push(text), 'Peer invalidation');
  await assert.rejects(db.transaction(async () => 'value'), (error) => error === failure);
  assert.deepEqual(calls, ['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
  assert.deepEqual(warnings, ['Peer invalidation rollback failed: database is locked']);
});
~~~

The CI step, inserted directly after the one `      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-commands/weather.test.js` line of `.github/workflows/migrations.yml`. That job has no job-level `env`. The two `replication.test.js` files keep their existing module-suite registration.

[[CI-STEP]]
~~~yaml
      - name: Issue 233 S2120 pair detach and cloud unclaim
        run: node --test scripts/test-issue-233-weather-detach.js
~~~

## 11. Focused fixture

`scripts/test-issue-233-weather-detach.js` drives the real wires from the route entries or from `sync-pending-split` through `reject-indefinite-open`, the gate, the generic replay node or the applier chain, Route Command and the adapter, to the HTTP response or MQTT node. Each profile loads its own `osi-irrigation-policy` through `nodeRedModules`. The DB facade mirrors production (`BEGIN IMMEDIATE`; `tx.run` resolves undefined) and a second file-backed connection drives the race. Node ids of the MQTT ACK and legacy SQL nodes come from current wires. With a `loader` option, `traverse` records every `osiLib.require` with the node that asked and answers `{ok:false}` for one named module on every request, resolving every other name as the harness does.

[[FIXTURE]]
~~~js
'use strict';
// Issue #233 Phase A: SENSECAP_S2120 selected-pair detach and trusted cloud UNCLAIM_DEVICE
// through the osi-irrigation-policy lifecycle owner, both maintained profiles. Cases follow
// the matrix in docs/superpowers/plans/issue-233-exact-plan.md.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const {
  executeFunction, facadeDb, loadNode, makeAuthHeader, moduleByName, profilePaths
} = require('./lib/scoped-access-harness');
const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'].map((name) => Object.assign({ name }, profilePaths(name)));
const DEVICE = '0011223344556677';
const GATEWAY = 'AABBCCDDEEFF0011';
const OTHER_GATEWAY = '0016C001F1000002';
const TRANSITION_GATEWAY = '0016C001F1000003';
const NONWEATHER = 'A840410000000002';
const Z1 = '00000000-0000-4000-8000-000000000001';
const Z2 = '00000000-0000-4000-8000-000000000002';
const ADMIN = '00000000-0000-4000-8000-000000000011';
const RESEARCHER = '00000000-0000-4000-8000-000000000012';
const VIEWER = '00000000-0000-4000-8000-000000000013';
const OTHER = '00000000-0000-4000-8000-000000000014';
const CURRENT_DAY = new Date().toISOString().slice(0, 10);
const SECRET = 'scoped-access-test-secret';
const ADAPTER = 'conditional-lifecycle-command-adapter';
const DEDUPE = 'command-dedupe-dispatch';
const GATE = 's2120-unclaim-gate';
const ACK_QUEUE = 'command-ack-queue-rest';

function policyFor(profile) {
  return require(path.join(profile.nodeRedModules, 'osi-irrigation-policy'));
}

function wiring(profile) {
  const mqttAck = loadNode('weather-zones-command-apply-fn', profile.flowsPath).wires[1][0];
  assert.equal(loadNode(mqttAck, profile.flowsPath).type, 'mqtt out');
  return { mqttAck, legacySql: loadNode(ADAPTER, profile.flowsPath).wires[0][0] };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue233-'));
  const file = path.join(dir, 'farming.db');
  const first = new DatabaseSync(file);
  first.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  first.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const users = [
    [1, 'admin1', ADMIN, 'admin'],
    [2, 'res1', RESEARCHER, 'researcher'],
    [3, 'view1', VIEWER, 'viewer'],
    [4, 'other1', OTHER, 'researcher']
  ];
  for (const row of users) first.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,user_uuid,role) VALUES (?,?,?,?,?,?)'
  ).run(row[0], row[1], 'h', '2026-01-01T00:00:00Z', row[2], row[3]);
  first.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui) VALUES (?,?,?,?,?)'
  ).run(1, 'Z One', 1, Z1, GATEWAY);
  first.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui) VALUES (?,?,?,?,?)'
  ).run(2, 'Z Two', 4, Z2, GATEWAY);
  first.prepare(
    'INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,sync_version,gateway_device_eui) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(DEVICE, 'Weather', 'SENSECAP_S2120', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 7, GATEWAY);
  first.prepare(
    'INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,sync_version,gateway_device_eui) VALUES (?,?,?,?,?,?,?,?)'
  ).run(NONWEATHER, 'Other', 'DRAGINO_LSN50', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 2, GATEWAY);
  for (const zoneId of [1, 2]) first.prepare(
    'INSERT INTO weather_station_zones(deveui,zone_id) VALUES (?,?)'
  ).run(DEVICE, zoneId);
  first.prepare('INSERT INTO device_data(deveui,recorded_at) VALUES (?,?)').run(DEVICE, '2026-01-01T12:00:00Z');
  first.prepare(
    'INSERT INTO zone_daily_environment(zone_id,date,rainfall_mm,flow_liters,rain_source,computed_at,rain_selected_deveui,sync_version) VALUES (?,?,?,?,?,?,?,?)'
  ).run(1, '2026-01-01', 2.5, 0, 'sensecap_s2120', '2026-01-02T00:00:00Z', DEVICE, 1);
  first.prepare(
    'INSERT INTO zone_rain_source(zone_id,selected_deveui,selected_at,selected_by_uuid,updated_at) VALUES (?,?,?,?,?)'
  ).run(1, DEVICE, '2026-01-01T00:00:00Z', ADMIN, '2026-01-01T00:00:00Z');
  first.prepare(
    'INSERT INTO weather_station_zone_state(deveui,sync_version,last_applied_at) VALUES (?,?,NULL)'
  ).run(DEVICE, 3);
  for (const [n, uuid] of [[1, Z1], [2, Z2]]) first.prepare(
    'INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at) VALUES (?,?,?,?)'
  ).run('00000000-0000-4000-8000-00000000002' + n, RESEARCHER, uuid, '2026-01-01T00:00:00Z');
  first.prepare('UPDATE users SET server_url=?,server_sync_token=? WHERE id=1')
    .run('https://example.invalid', 'fixture-sync-token');
  first.prepare(
    'INSERT INTO sync_link_state(peer_node,linked,server_url,gateway_device_eui,updated_at) VALUES (?,?,?,?,?)'
  ).run('cloud', 1, 'https://example.invalid', GATEWAY, '2026-01-01T00:00:00Z');
  const second = new DatabaseSync(file);
  second.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  for (const profile of PROFILES) {
    require(path.join(profile.nodeRedModules, 'osi-scope-helper'))._resetForTests();
  }
  return {
    first, second, file,
    close() {
      second.close();
      first.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// Production osi-db-helper semantics: BEGIN IMMEDIATE, and run() resolves undefined, so no
// code under test can read .changes. beforeBegin runs once, before the first BEGIN.
function productionFacade(raw, beforeBegin) {
  const f = facadeDb(raw);
  let pending = beforeBegin || null;
  return Object.assign({}, f, {
    run(sql, params, callback) {
      if (typeof params === 'function' || typeof callback === 'function') return f.run(sql, params, callback);
      return f.run(sql, params).then(() => undefined);
    },
    async transaction(fn) {
      if (pending) {
        const hook = pending;
        pending = null;
        await hook();
      }
      raw.exec('BEGIN IMMEDIATE');
      const tx = {
        get: (sql, params) => f.get(sql, params),
        all: (sql, params) => f.all(sql, params),
        run: async (sql, params) => {
          await f.run(sql, params);
          return undefined;
        }
      };
      try {
        const answer = await fn(tx);
        raw.exec('COMMIT');
        return answer;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    }
  });
}

function libsFor(profile, facade, policy) {
  const Database = function Database() { return facade; };
  const osiLibModules = { 'osi-db-helper': { Database } };
  if (policy) osiLibModules['osi-irrigation-policy'] = policy;
  return { nodeRedModules: profile.nodeRedModules, osiLibModules, libOverrides: { osiDb: { Database } } };
}

// Follows real output indexes across wires. Stops at http response, mqtt out, link out and
// the legacy SQL builder, and records every emission. With options.loader, every
// osiLib.require in the chain is recorded with the node that asked, and the one module named
// by loader.fault answers {ok:false} on every request; all other names resolve as the harness
// resolves them.
async function traverse(profile, startId, msg, raw, options = {}) {
  const facade = productionFacade(raw, options.beforeBegin);
  const libs = libsFor(profile, facade, options.policy);
  const ids = wiring(profile);
  let current = null;
  if (options.loader) {
    const loader = options.loader;
    libs.libOverrides.osiLib = {
      require(name) {
        loader.requests.push({ node: current, name });
        if (loader.fault && loader.fault.name === name) return { ok: false, error: loader.fault.error };
        const value = libs.osiLibModules[name] || moduleByName(name, profile.nodeRedModules);
        return value ? { ok: true, value } : { ok: false, error: 'unregistered in harness: ' + name };
      }
    };
  }
  const out = { responses: [], mqtt: [], legacy: [], visited: [], trace: [], errors: [], warnings: [] };
  let flowState = options.flowState || {};
  const env = Object.assign({
    OSI_SCOPED_ACCESS: options.scoped ? '1' : '0',
    DEVICE_EUI: GATEWAY,
    AUTH_TOKEN_SECRET: SECRET,
    DEVICE_EUI_CONFIDENCE: 'active'
  }, options.env || {});
  async function visit(id, value) {
    if (value == null) return;
    out.visited.push(id);
    if (id === ids.legacySql) {
      out.legacy.push(value);
      return;
    }
    const node = loadNode(id, profile.flowsPath);
    if (node.type === 'http response') {
      out.responses.push(value);
      return;
    }
    if (node.type === 'mqtt out') {
      out.mqtt.push(value);
      return;
    }
    if (node.type === 'link out') return;
    let output;
    if (node.type === 'sqlite') {
      value.payload = raw.prepare(value.topic).all();
      output = [value];
    } else if (node.type === 'function') {
      current = id;
      const call = await executeFunction(node, Object.assign({
        msg: value, db: raw, flowState, env, globals: options.globals || {}
      }, libs));
      out.errors.push(...call.errors.map((error) => id + ': ' + error));
      out.warnings.push(...call.warnings.map((warning) => id + ': ' + warning));
      flowState = call.flowState;
      output = Array.isArray(call.result) ? call.result : [call.result];
    } else {
      output = [value];
    }
    for (let slot = 0; slot < output.length; slot++) {
      const emitted = Array.isArray(output[slot]) ? output[slot] : [output[slot]];
      for (const item of emitted) {
        if (item == null) continue;
        out.trace.push({ id, slot, value: item });
        for (const child of node.wires[slot] || []) await visit(child, item);
      }
    }
  }
  await visit(startId, msg);
  out.flowState = flowState;
  return out;
}

function assertOneResponse(result, status, label) {
  assert.equal(result.responses.length, 1, label + ': exactly one HTTP response');
  assert.equal(result.responses[0].statusCode, status, label);
}

function mutantPolicy(profile, edit) {
  const filename = path.join(profile.nodeRedModules, 'osi-irrigation-policy', 'lifecycle.js');
  const original = fs.readFileSync(filename, 'utf8');
  const changed = edit(original);
  assert.notEqual(changed, original);
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(changed, filename);
  return Object.assign({}, policyFor(profile), m.exports);
}

// Routes mutants (M4, M5): an in-memory copy of the profile's routes.js. Every call that goes
// through the returned policy, including the gate node and the adapter, reaches the mutant.
function mutantRoutesPolicy(profile, edit) {
  const filename = path.join(profile.nodeRedModules, 'osi-irrigation-policy', 'routes.js');
  const original = fs.readFileSync(filename, 'utf8');
  const changed = edit(original);
  assert.notEqual(changed, original);
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(changed, filename);
  return Object.assign({}, policyFor(profile), { routes: m.exports });
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2);
  return source.replace(before, after);
}

const CLEANUP_LINE = "    if (operation === 'device_unclaim' && input[CLOUD_S2120_UNCLAIM] === true) await clearCloudS2120WeatherLinksTx(tx, current, at, input.gatewayDeviceEui);";
const DEVICE_UPDATE_LINE = '    await tx.run(`UPDATE devices SET ${fields}, updated_at=?, sync_version=? WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL`, params);';
const MUTATIONS = [
  (s) => replaceOnce(s,
    "'DELETE FROM weather_station_zones WHERE deveui=? AND zone_id=?'",
    "'UPDATE weather_station_zones SET zone_id=zone_id WHERE deveui=? AND zone_id=?'"),
  (s) => replaceOnce(s, 'VALUES (?,0,NULL,?)', 'VALUES (?,1,NULL,?)'),
  (s) => replaceOnce(s, CLEANUP_LINE + '\n' + DEVICE_UPDATE_LINE, DEVICE_UPDATE_LINE + '\n' + CLEANUP_LINE),
  (s) => replaceOnce(s, 'prior.binding_hash !== hash', 'false')
];
const LEASE_LINE = '  envelope.leasedToGateway = command.leasedToGateway == null ? null : command.leasedToGateway;\n';
const GATE_ROUTE_LINE = '    return identity.station ? [null, msg] : [msg, null];';
const ROUTE_MUTATIONS = [
  (s) => replaceOnce(s, LEASE_LINE, ''),
  (s) => replaceOnce(s, GATE_ROUTE_LINE, '    return [msg, null];')
];
// Each mutant counts as killed only by an AssertionError whose message holds every listed text.
const KILLS = [
  ['MUTANT_PAIR_DELETE'],
  ['MUTANT_FIRST_STATE'],
  ['MUTANT_EVENT_ORDER'],
  ['MUTANT_BINDING'],
  ['MUTANT_LEASE', 'lease_gateway_unavailable_or_mismatch'],
  ['MUTANT_GATE_ROUTE', DEDUPE + ': Command dedupe failed closed: WATERMARK command replay binding conflicts with the terminal ledger']
];

function auth(id, username) {
  return makeAuthHeader({ userId: id, username, secret: SECRET });
}

const D = [
  { id: 'D01', scoped: true, zone: 1, actor: [1, 'admin1'], status: 200 },
  { id: 'D02', scoped: true, zone: 2, actor: [2, 'res1'], status: 200 },
  { id: 'D03', scoped: false, zone: 1, actor: [1, 'admin1'], status: 200 },
  { id: 'D04', scoped: false, zone: 2, actor: [1, 'admin1'], status: 200 },
  { id: 'D05', scoped: true, zone: 1, actor: [1, 'admin1'], onlyOne: true, firstState: true, status: 200 },
  { id: 'D06', scoped: false, zone: 1, actor: [1, 'admin1'], onlyOne: true, status: 200 },
  { id: 'D07', scoped: true, zone: 2, actor: [2, 'res1'], crossOwner: true, status: 200 },
  { id: 'D08', scoped: false, zone: 2, actor: [1, 'admin1'], crossOwner: true, status: 200 },
  { id: 'D09', scoped: true, zone: 2, actor: [2, 'res1'], revoke: true, status: 404 },
  { id: 'D10', scoped: true, zone: 1, actor: [3, 'view1'], status: 403 },
  { id: 'D11', scoped: false, zone: 2, actor: [2, 'res1'], status: 404 },
  { id: 'D12', scoped: true, zone: 1, actor: [1, 'admin1'], primaryOnly: true, status: 200 }
];

function deviceState(raw) {
  return raw.prepare('SELECT user_id,irrigation_zone_id,sync_version FROM devices WHERE deveui=?').get(DEVICE);
}

function assignments(raw) {
  return raw.prepare('SELECT zone_id FROM weather_station_zones WHERE deveui=? ORDER BY zone_id')
    .all(DEVICE).map((row) => row.zone_id);
}

function weatherVersion(raw) {
  const row = raw.prepare('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?').get(DEVICE);
  return row ? row.sync_version : null;
}

function weatherEvents(raw) {
  return raw.prepare(
    "SELECT payload_json FROM sync_outbox WHERE aggregate_key=? AND op='WEATHER_STATION_ZONES_REPLACED' ORDER BY rowid"
  ).all(DEVICE).map((row) => JSON.parse(row.payload_json));
}

function historyRows(raw) {
  const read = (sql) => raw.prepare(sql).all().map((row) => ({ ...row }));
  return {
    days: read('SELECT * FROM zone_daily_environment ORDER BY zone_id,date'),
    data: read('SELECT * FROM device_data ORDER BY id'),
    preference: read('SELECT * FROM zone_rain_source ORDER BY zone_id')
  };
}

async function currentCandidates(profile, raw, zoneId) {
  const rain = require(path.join(profile.nodeRedModules, 'osi-rain/index.js'));
  const selected = await rain.selectZoneGauge(productionFacade(raw), zoneId, CURRENT_DAY);
  return selected.candidates;
}

async function detachCase(profile, spec, policy) {
  const f = fixture();
  try {
    if (spec.onlyOne) f.first.prepare('DELETE FROM weather_station_zones WHERE deveui=? AND zone_id=2').run(DEVICE);
    if (spec.primaryOnly) f.first.prepare('DELETE FROM weather_station_zones WHERE deveui=? AND zone_id=1').run(DEVICE);
    if (spec.firstState) f.first.prepare('DELETE FROM weather_station_zone_state WHERE deveui=?').run(DEVICE);
    if (spec.revoke) f.first.prepare(
      'UPDATE user_zone_assignments SET deleted_at=? WHERE user_uuid=? AND zone_uuid=?'
    ).run('2026-01-02T00:00:00Z', RESEARCHER, Z2);
    const before = assignments(f.first);
    const historical = historyRows(f.first);
    const primaryBefore = deviceState(f.first).irrigation_zone_id;
    const currentBefore = [
      await currentCandidates(profile, f.first, 1),
      await currentCandidates(profile, f.first, 2)
    ];
    assert.deepEqual(currentBefore, [1, 2].map((zoneId) =>
      before.includes(zoneId) || primaryBefore === zoneId ? [DEVICE] : []));
    const msg = {
      req: {
        method: 'DELETE',
        headers: { authorization: auth(...spec.actor) },
        params: { id: String(spec.zone), deveui: DEVICE }
      },
      payload: {}
    };
    const result = await traverse(profile, 'scoped-device-unassign-router', msg, f.first, { scoped: spec.scoped, policy });
    if (policy && result.responses.length === 1 && result.responses[0].statusCode === 500 &&
        ['D01', 'D05'].includes(spec.id)) {
      const diagnostic = JSON.stringify(result.responses[0].payload) + ' ' + result.errors.join('|');
      assert.match(diagnostic, /detach_postcondition_failed|weather_outbox_postcondition_failed/);
      assert.deepEqual(assignments(f.first), before, 'postcondition failure rolls back the mutant');
      assert.fail(spec.id === 'D01' ? 'MUTANT_PAIR_DELETE' : 'MUTANT_FIRST_STATE');
    }
    assertOneResponse(result, spec.status, spec.id + (spec.id === 'D04' || spec.id === 'D08'
      ? ' flag-off secondary weather pair detach (base defect: lifecycle.js:454-455 answers 404 for a pair that is not the primary)'
      : ' route status'));
    const changed = spec.status === 200;
    const after = assignments(f.first);
    const expected = changed ? before.filter((id) => id !== spec.zone) : before;
    assert.deepEqual(after, expected, 'selected weather pair removed, other pairs kept (MUTANT_PAIR_DELETE)');
    assert.equal(f.first.prepare('SELECT COUNT(*) AS n FROM device_data WHERE deveui=?').get(DEVICE).n, 1);
    const state = deviceState(f.first);
    const selectedPrimary = spec.zone === 1;
    assert.equal(state.irrigation_zone_id, changed && selectedPrimary ? null : 1);
    assert.equal(state.sync_version, changed && selectedPrimary ? 8 : 7);
    if (changed) assert.equal(result.responses[0].payload.irrigation_zone_id, state.irrigation_zone_id,
      'the response reports the persisted primary zone');
    for (const zoneId of [1, 2]) {
      const expectedLive = after.includes(zoneId) || state.irrigation_zone_id === zoneId ? [DEVICE] : [];
      assert.deepEqual(await currentCandidates(profile, f.first, zoneId), expectedLive, 'osi-rain current-window zone ' + zoneId);
    }
    assert.deepEqual(historyRows(f.first), historical, 'detach keeps historical rain, telemetry and preference rows');
    const pairRemoved = changed && before.includes(spec.zone);
    assert.equal(weatherVersion(f.first),
      pairRemoved ? (spec.firstState ? 1 : 4) : (spec.firstState ? null : 3), 'MUTANT_FIRST_STATE');
    const events = weatherEvents(f.first);
    assert.equal(events.length, pairRemoved ? 1 : 0);
    if (pairRemoved) assert.deepEqual(events[0].zone_uuids, expected.map((id) => id === 1 ? Z1 : Z2));
    if (spec.id === 'D01' && !policy) {
      const repeated = await traverse(profile, 'scoped-device-unassign-router', {
        req: { method: 'DELETE', headers: { authorization: auth(1, 'admin1') }, params: { id: '1', deveui: DEVICE } },
        payload: {}
      }, f.first, { scoped: true });
      assertOneResponse(repeated, 404, 'D01 repeated detach');
      assert.equal(weatherEvents(f.first).length, 1);
    }
  } finally {
    f.close();
  }
}

async function unlinkedDetachCase(profile) {
  const f = fixture();
  try {
    f.first.prepare("UPDATE sync_link_state SET linked=0 WHERE peer_node='cloud'").run();
    const result = await traverse(profile, 'scoped-device-unassign-router', {
      req: { method: 'DELETE', headers: { authorization: auth(1, 'admin1') }, params: { id: '2', deveui: DEVICE } },
      payload: {}
    }, f.first, { scoped: false, env: { DEVICE_EUI: '' } });
    assertOneResponse(result, 200, 'unlinked flag-off detach');
    assert.deepEqual(assignments(f.first), [1]);
    assert.equal(weatherVersion(f.first), 4);
    assert.equal(weatherEvents(f.first).length, 0);
  } finally {
    f.close();
  }
}

function command(id = 123, target = 8) {
  return {
    commandId: id,
    commandType: 'UNCLAIM_DEVICE',
    eventUuid: '00000000-0000-4000-8000-000000000031',
    aggregateType: 'DEVICE',
    aggregateKey: DEVICE,
    appliedSyncVersion: target,
    effectKey: null,
    leasedToGateway: GATEWAY,
    payload: { deviceEui: DEVICE, gatewayDeviceEui: GATEWAY, syncVersion: target, commandType: 'UNCLAIM_DEVICE' }
  };
}

async function cloudCall(profile, f, issued, opts = {}) {
  const run = await traverse(profile, 'sync-pending-split', { statusCode: 200, payload: { commands: [issued] } }, f.first, {
    scoped: false,
    policy: opts.policy,
    beforeBegin: opts.beforeBegin,
    loader: opts.loader,
    env: opts.runtimeGatewayEui === undefined ? {} : { DEVICE_EUI: opts.runtimeGatewayEui }
  });
  assert.ok(require.cache[path.join(profile.nodeRedModules, 'osi-irrigation-policy', 'lifecycle.js')],
    profile.name + ' loads its own lifecycle owner');
  assert.ok(run.mqtt.length <= 1, 'at most one MQTT ACK per delivery');
  const split = run.trace.find((item) => item.id === 'sync-pending-split' && item.slot === 0);
  return Object.assign(run, {
    splitMessage: split ? split.value : null,
    gate: run.trace.filter((item) => item.id === GATE),
    dedupe: run.trace.filter((item) => item.id === DEDUPE),
    adapter: run.trace.filter((item) => item.id === ADAPTER)
  });
}

function ackFrom(call) {
  return call.mqtt.length ? JSON.parse(call.mqtt[0].payload) : null;
}

function terminalSnapshot(raw) {
  const rows = (sql) => raw.prepare(sql).all().map((row) => ({ ...row }));
  return {
    devices: rows('SELECT * FROM devices ORDER BY deveui'),
    zones: rows('SELECT * FROM irrigation_zones ORDER BY id'),
    joins: rows('SELECT * FROM weather_station_zones ORDER BY deveui,zone_id'),
    weatherState: rows('SELECT * FROM weather_station_zone_state ORDER BY deveui'),
    history: historyRows(raw),
    outbox: rows('SELECT * FROM sync_outbox ORDER BY rowid'),
    ledger: rows('SELECT * FROM applied_commands ORDER BY command_id'),
    restAck: rows('SELECT * FROM command_ack_outbox ORDER BY id')
  };
}

function ackRows(raw) {
  return raw.prepare('SELECT payload_json FROM command_ack_outbox WHERE delivered_at IS NULL ORDER BY id')
    .all().map((row) => row.payload_json);
}

async function batchTieCase(profile, earlierCount) {
  const f = fixture();
  try {
    const forced = loadNode('sync-force-build', profile.flowsPath);
    assert.ok(forced.func.includes('ORDER BY occurred_at ASC, rowid ASC LIMIT 100'));
    const applied = await cloudCall(profile, f, command());
    assert.equal(ackFrom(applied).result, 'APPLIED');
    f.first.prepare(
      "UPDATE sync_outbox SET occurred_at=? WHERE aggregate_key=? AND op IN ('WEATHER_STATION_ZONES_REPLACED','DEVICE_UNCLAIMED')"
    ).run('2026-01-02T00:00:00.000Z', DEVICE);
    for (let n = 0; n < earlierCount; n++) f.first.prepare(
      'INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui) ' +
      "SELECT ?,aggregate_type,aggregate_key,op,payload_json,sync_version,?,gateway_device_eui FROM sync_outbox WHERE op='DEVICE_UNCLAIMED' AND aggregate_key=? LIMIT 1"
    ).run('00000000-0000-4000-8000-' + String(n + 1).padStart(12, '0'), '2026-01-01T00:00:00.000Z', DEVICE);
    async function build() {
      const libs = libsFor(profile, productionFacade(f.first));
      const result = await executeFunction(loadNode('sync-outbox-build', profile.flowsPath), Object.assign({
        msg: {},
        db: f.first,
        globals: { fs: { existsSync: () => false } },
        env: { DEVICE_EUI: GATEWAY, DEVICE_EUI_CONFIDENCE: 'active', DEVICE_EUI_SOURCE: 'test' },
        flowState: { outboxFlushInFlightAt: 0, sync_state: {} }
      }, libs));
      assert.deepEqual(result.errors, []);
      assert.ok(result.result && result.result.payload);
      return result.result.payload.events;
    }
    const firstBatch = await build();
    assert.equal(firstBatch.length, 100);
    const weatherIndex = firstBatch.findIndex((event) => event.op === 'WEATHER_STATION_ZONES_REPLACED');
    const deviceIndex = firstBatch.findIndex((event) =>
      event.op === 'DEVICE_UNCLAIMED' && event.occurredAt === '2026-01-02T00:00:00.000Z');
    assert.equal(weatherIndex, earlierCount);
    assert.equal(deviceIndex, earlierCount === 98 ? 99 : -1);
    assert.deepEqual(firstBatch[weatherIndex].payload.zone_uuids, []);
    const firstIds = new Set(firstBatch.map((event) => event.eventUuid));
    assert.equal(firstIds.size, 100);
    if (earlierCount === 99) {
      for (const event of firstBatch) f.first.prepare('UPDATE sync_outbox SET delivered_at=? WHERE event_uuid=?')
        .run('2026-01-03T00:00:00.000Z', event.eventUuid);
      const secondBatch = await build();
      assert.equal(secondBatch.length, 1);
      assert.equal(secondBatch[0].op, 'DEVICE_UNCLAIMED');
      assert.ok(!firstIds.has(secondBatch[0].eventUuid));
    }
    f.first.prepare(
      'UPDATE sync_outbox SET delivered_at=NULL,rejected_at=NULL,retry_count=0,last_retryable_failure_at=NULL WHERE aggregate_key=?'
    ).run(DEVICE);
    f.first.prepare("UPDATE users SET auth_mode='server',cloud_user_id=7 WHERE id=1").run();
    const forceRequests = [];
    const cloud = { requestJsonIpv4: async (request) => {
      if (request.url.endsWith('/auth/refresh-sync')) return { statusCode: 200, payload: { token: 'fixture-sync-token' } };
      if (request.url.endsWith('/api/v1/sync/edge/bootstrap')) return { statusCode: 200, payload: { applied: 1, skipped: 0 } };
      if (request.url.endsWith('/api/v1/sync/edge/events')) {
        forceRequests.push(request.payload);
        return { statusCode: 200, payload: { results: request.payload.events.map((event) => ({ eventUuid: event.eventUuid, status: 'APPLIED' })) } };
      }
      if (request.url.includes('/pending-commands')) return { statusCode: 200, payload: { commands: [] } };
      throw new Error('unexpected force request ' + request.url);
    } };
    async function forceOnce() {
      const libs = libsFor(profile, productionFacade(f.first));
      const msg = { _forceSyncInternal: true, _forceSyncUserId: 1, _forceSyncUsername: 'admin1' };
      const result = await executeFunction(forced, Object.assign({
        msg,
        db: f.first,
        env: {
          DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'test', DEVICE_EUI_CONFIDENCE: 'active',
          OSI_SCOPED_ACCESS: '0', AUTH_TOKEN_SECRET: SECRET
        },
        globals: { fs: { existsSync: () => false } }
      }, libs, { libOverrides: Object.assign({}, libs.libOverrides, { osiCloudHttp: cloud }) }));
      assert.deepEqual(result.errors, []);
      assert.ok(msg.statusCode === 200 || msg.statusCode === 207, JSON.stringify(msg.payload));
      return result;
    }
    await forceOnce();
    assert.equal(forceRequests.length, 1);
    const forceFirst = forceRequests[0].events;
    assert.equal(forceFirst.length, 100);
    const forceWeather = forceFirst.findIndex((event) => event.op === 'WEATHER_STATION_ZONES_REPLACED');
    const forceDevice = forceFirst.findIndex((event) =>
      event.op === 'DEVICE_UNCLAIMED' && event.occurredAt === '2026-01-02T00:00:00.000Z');
    assert.equal(forceWeather, earlierCount);
    assert.equal(forceDevice, earlierCount === 98 ? 99 : -1);
    assert.deepEqual(forceFirst[forceWeather].payload.zone_uuids, []);
    const forceIds = new Set(forceFirst.map((event) => event.eventUuid));
    assert.equal(forceIds.size, 100);
    if (earlierCount === 99) {
      await forceOnce();
      assert.equal(forceRequests.length, 2);
      const forceSecond = forceRequests[1].events;
      assert.equal(forceSecond.length, 1);
      assert.equal(forceSecond[0].op, 'DEVICE_UNCLAIMED');
      assert.ok(!forceIds.has(forceSecond[0].eventUuid));
    }
  } finally {
    f.close();
  }
}

// Issue #233: replaces the static force-sync lease text check. A cloud S2120 UNCLAIM_DEVICE
// delivered by force sync carries its lease only beside the envelope; the gate adds it, and the
// owner applies the unclaim.
async function forceDeliveryCase(profile) {
  const f = fixture();
  try {
    f.first.prepare("UPDATE users SET auth_mode='server',cloud_user_id=7 WHERE id=1").run();
    const issued = command();
    const cloud = { requestJsonIpv4: async (request) => {
      if (request.url.endsWith('/auth/refresh-sync')) return { statusCode: 200, payload: { token: 'fixture-sync-token' } };
      if (request.url.endsWith('/api/v1/sync/edge/bootstrap')) return { statusCode: 200, payload: { applied: 1, skipped: 0 } };
      if (request.url.endsWith('/api/v1/sync/edge/events')) {
        return { statusCode: 200, payload: { results: request.payload.events.map((event) => ({ eventUuid: event.eventUuid, status: 'APPLIED' })) } };
      }
      if (request.url.includes('/pending-commands')) return { statusCode: 200, payload: { commands: [issued] } };
      throw new Error('unexpected force request ' + request.url);
    } };
    const libs = libsFor(profile, productionFacade(f.first));
    const msg = { _forceSyncInternal: true, _forceSyncUserId: 1, _forceSyncUsername: 'admin1' };
    const forced = await executeFunction(loadNode('sync-force-build', profile.flowsPath), Object.assign({
      msg,
      db: f.first,
      env: {
        DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'test', DEVICE_EUI_CONFIDENCE: 'active',
        OSI_SCOPED_ACCESS: '0', AUTH_TOKEN_SECRET: SECRET
      },
      globals: { fs: { existsSync: () => false } }
    }, libs, { libOverrides: Object.assign({}, libs.libOverrides, { osiCloudHttp: cloud }) }));
    assert.deepEqual(forced.errors, []);
    const queued = Array.isArray(forced.result) ? forced.result[1] : null;
    assert.ok(Array.isArray(queued) && queued.length === 1, 'force sync queues the one pending command');
    assert.equal(queued[0].payload.leasedToGateway, GATEWAY);
    assert.equal(queued[0].payload._pendingCommandEnvelope.leasedToGateway, undefined,
      'force sync leaves the envelope lease to the S2120 unclaim gate');
    const run = await traverse(profile, 'reject-indefinite-open', queued[0], f.first, { scoped: false });
    const gate = run.trace.filter((item) => item.id === GATE);
    assert.ok(gate.length === 1 && gate[0].slot === 1, 'the gate sends the force-delivered S2120 unclaim to its owner');
    assert.equal(gate[0].value.payload._pendingCommandEnvelope.leasedToGateway, GATEWAY);
    assert.equal(run.trace.filter((item) => item.id === DEDUPE).length, 0);
    const ack = ackFrom(run);
    assert.ok(ack, 'the force-delivered unclaim publishes one terminal ACK');
    assert.equal(ack.result, 'APPLIED');
    assert.deepEqual(assignments(f.first), [], 'the force-delivered unclaim removes every weather link');
  } finally {
    f.close();
  }
}

const EXPECTED = {
  C01: ['APPLIED', null, false],
  C02: ['CONFLICT', 'stale_sync_version', false],
  C03: ['APPLIED', null, true],
  C04: ['CONFLICT', 'equal_version_postcondition_failed', false],
  C05: ['CONFLICT', 'version_gap', false],
  C06: ['REJECTED_PERMANENT', 'invalid_version', false],
  C07: ['REJECTED_PERMANENT', 'malformed_command', false],
  C11: ['REJECTED_PERMANENT', 'malformed_command', false],
  C12: ['REJECTED_PERMANENT', 'malformed_command', false]
};

async function cloudCase(profile, id, policy) {
  const f = fixture();
  try {
    const issued = command();
    if (id === 'C02') issued.payload.syncVersion = issued.appliedSyncVersion = 6;
    if (id === 'C03' || id === 'C04') {
      issued.payload.syncVersion = issued.appliedSyncVersion = 7;
      f.first.prepare('UPDATE devices SET user_id=NULL,irrigation_zone_id=NULL WHERE deveui=?').run(DEVICE);
      if (id === 'C03') f.first.prepare('DELETE FROM weather_station_zones WHERE deveui=?').run(DEVICE);
    }
    if (id === 'C05') issued.payload.syncVersion = issued.appliedSyncVersion = 9;
    if (id === 'C06') issued.payload.syncVersion = issued.appliedSyncVersion = Number.MAX_SAFE_INTEGER + 1;
    if (id === 'C07') issued.payload.unexpected = true;
    if (id === 'C08') f.first.prepare("UPDATE devices SET type_id='DRAGINO_LSN50' WHERE deveui=?").run(DEVICE);
    if (id === 'C09') issued.commandId = '123';
    if (id === 'C10') issued.leasedToGateway = null;
    if (id === 'C11') issued.aggregateKey = NONWEATHER;
    if (id === 'C12') issued.aggregateKey = null;
    const before = { device: deviceState(f.first), links: assignments(f.first) };
    const beforeTerminal = terminalSnapshot(f.first);
    const call = await cloudCall(profile, f, issued, { policy });
    const ack = ackFrom(call);
    const sent = (slot) => call.adapter.some((item) => item.slot === slot);
    if (id === 'C08') {
      assert.equal(call.dedupe.length, 1);
      assert.equal(call.dedupe[0].slot, 0);
      assert.strictEqual(call.dedupe[0].value, call.splitMessage, 'C08 generic dedupe passes the identical split message on');
      assert.ok(call.gate.length === 1 && call.gate[0].slot === 0 && call.gate[0].value === call.splitMessage,
        'C08 the gate passes a non-S2120 unclaim on to the generic replay check unchanged');
      assert.equal(call.splitMessage.payload._pendingCommandEnvelope.leasedToGateway, GATEWAY,
        'C08 the gate adds the trusted lease to every cloud unclaim envelope');
      assert.ok(sent(1) && !sent(2), 'C08 non-S2120 unclaim keeps the generic owner path and its ACK queue');
      assert.ok(call.visited.includes(ACK_QUEUE));
      assert.equal(call.legacy.length, 0);
      assert.ok(ack);
      assert.equal(ack.result, 'APPLIED');
      assert.equal(ack.valveCleanup.outcome, 'not_applicable');
      assert.equal(deviceState(f.first).user_id, null, 'the unchanged generic unclaim applied to the non-weather device');
      const afterTerminal = terminalSnapshot(f.first);
      assert.deepEqual(afterTerminal.joins, beforeTerminal.joins, 'C08 non-S2120 unclaim gains no weather cleanup');
      assert.deepEqual(afterTerminal.weatherState, beforeTerminal.weatherState);
      assert.equal(weatherEvents(f.first).length, 0);
      const ledger = f.first.prepare('SELECT originator, binding_hash FROM applied_commands WHERE command_id=?').get('123');
      assert.equal(ledger.originator, 'edge');
      assert.equal(ledger.binding_hash, null);
    } else if (id === 'C09' || id === 'C10') {
      const assertHeld = (out, reason) => {
        assert.equal(ackFrom(out), null, reason + ': no ACK');
        assert.equal(out.legacy.length, 0, reason + ': never reaches legacy SQL');
        assert.ok(!out.visited.includes(ACK_QUEUE), reason + ': generic ACK queue untouched');
        assert.ok(out.gate.length === 1 && out.gate[0].slot === 1 && out.dedupe.length === 0,
          reason + ': the gate sends the S2120 unclaim past the generic replay check to its owner');
        assert.equal(out.adapter.length, 0, reason + ': the adapter emits nothing');
        assert.ok(out.warnings.some((warning) => warning.includes('S2120 unclaim held') && warning.includes(reason)), reason);
        assert.deepEqual(terminalSnapshot(f.first), beforeTerminal, reason + ': no canonical, ledger or outbox row changes');
      };
      assertHeld(call, id === 'C09' ? 'invalid_command_id' : 'lease_gateway_unavailable_or_mismatch');
      if (id === 'C10') {
        for (const variant of [
          { lease: '' },
          { lease: OTHER_GATEWAY },
          { lease: GATEWAY, runtime: TRANSITION_GATEWAY }
        ]) {
          issued.leasedToGateway = variant.lease;
          assertHeld(await cloudCall(profile, f, issued, { policy, runtimeGatewayEui: variant.runtime }),
            'lease_gateway_unavailable_or_mismatch');
        }
        issued.leasedToGateway = GATEWAY;
        for (const [sql, reason] of [
          ["UPDATE sync_link_state SET gateway_device_eui='" + TRANSITION_GATEWAY + "' WHERE peer_node='cloud'", 'link_gateway_transition'],
          ["UPDATE sync_link_state SET gateway_device_eui='" + GATEWAY + "', link_attempt_json='{\"attempt\":\"fixture\"}' WHERE peer_node='cloud'", 'link_in_progress'],
          ["UPDATE sync_link_state SET link_attempt_json=NULL, linked=0 WHERE peer_node='cloud'", 'link_inactive']
        ]) {
          f.first.exec(sql);
          assertHeld(await cloudCall(profile, f, issued, { policy }), reason);
        }
      }
    } else {
      const held = call.warnings.find((warning) => warning.includes('S2120 unclaim held'));
      assert.equal(held, undefined,
        id + ': the owner decides a trusted, leased S2120 unclaim instead of holding it (MUTANT_LEASE): ' + held);
      if (id === 'C01' && !ack && policy) {
        assert.match(call.errors.join('|'), /unclaim_outbox_postcondition_failed/);
        assert.fail('MUTANT_EVENT_ORDER');
      }
      if (id === 'C01') {
        assert.deepEqual(assignments(f.first), [],
          'cloud S2120 unclaim removes every weather link (base defect: lifecycle.js:521-528 writes only the device row)');
      }
      const [result, reasonCode, duplicate] = EXPECTED[id];
      assert.ok(ack, id + ' publishes one terminal ACK');
      assert.equal(ack.result, result);
      assert.equal(ack.reasonCode, reasonCode);
      assert.equal(ack.duplicate, duplicate);
      assert.equal(ack.status, result === 'APPLIED' ? 'ACKED' : (result === 'CONFLICT' ? 'CONFLICT' : 'NACKED'));
      assert.equal(ack.payloadHash, null);
      assert.equal(ack.gatewayDeviceEui, GATEWAY);
      assert.equal(ack.valveCleanup.outcome, result === 'APPLIED' ? 'not_applicable' : 'not_attempted');
      assert.ok(call.gate.length === 1 && call.gate[0].slot === 1 && call.dedupe.length === 0,
        id + ': the gate sends the S2120 unclaim past the generic replay check to its owner');
      assert.ok(sent(2) && !sent(1) && !sent(0), id + ': the adapter answers on its S2120 output only');
      assert.ok(!call.visited.includes(ACK_QUEUE), id + ': the generic ACK queue never reclassifies this decision');
      assert.equal(call.legacy.length, 0);
      const pending = ackRows(f.first);
      assert.equal(pending.length, 1, 'one pending REST ACK');
      assert.equal(pending[0], call.mqtt[0].payload, 'the MQTT copy is byte-identical to the durable REST ACK');
      const ledger = f.first.prepare('SELECT * FROM applied_commands WHERE command_id=?').get('123');
      assert.equal(ledger.originator, 'cloud');
      assert.match(ledger.binding_hash, /^[0-9a-f]{64}$/);
      assert.equal(ledger.result, result);
      assert.equal(ledger.result_detail, pending[0]);
      if (id === 'C01') {
        assert.equal(deviceState(f.first).user_id, null);
        assert.equal(deviceState(f.first).irrigation_zone_id, null);
        assert.equal(deviceState(f.first).sync_version, 8);
        assert.equal(weatherVersion(f.first), 4);
        const events = f.first.prepare('SELECT rowid,op,payload_json FROM sync_outbox WHERE aggregate_key=? ORDER BY rowid').all(DEVICE);
        const weather = events.find((row) => row.op === 'WEATHER_STATION_ZONES_REPLACED');
        const unclaim = events.find((row) => row.op === 'DEVICE_UNCLAIMED');
        assert.ok(weather && unclaim);
        assert.ok(weather.rowid < unclaim.rowid, 'MUTANT_EVENT_ORDER');
        assert.deepEqual(JSON.parse(weather.payload_json).zone_uuids, []);
        assert.deepEqual(historyRows(f.first), beforeTerminal.history);
        if (!policy) {
          await batchTieCase(profile, 98);
          await batchTieCase(profile, 99);
        }
      } else {
        assert.deepEqual(deviceState(f.first), before.device);
        assert.deepEqual(assignments(f.first), before.links);
        if (id === 'C11' || id === 'C12') {
          assert.equal(ack.aggregateKey, null);
          assert.equal(ack.resourceUuid, null);
          const afterTerminal = terminalSnapshot(f.first);
          assert.deepEqual(afterTerminal.weatherState, beforeTerminal.weatherState);
          assert.deepEqual(afterTerminal.outbox, beforeTerminal.outbox);
        }
      }
    }
  } finally {
    f.close();
  }
}

async function replayCase(profile, id, policy) {
  const f = fixture();
  try {
    if (id === 'R04') {
      const beforeFault = terminalSnapshot(f.first);
      assert.equal(beforeFault.devices.find((row) => row.deveui === DEVICE).user_id, 1);
      assert.deepEqual(beforeFault.joins.map((row) => row.zone_id), [1, 2]);
      f.first.exec("CREATE TRIGGER fail_issue233_ledger BEFORE INSERT ON applied_commands BEGIN SELECT RAISE(ABORT,'ledger fault'); END");
      const failed = await cloudCall(profile, f, command(125, 8), { policy });
      assert.equal(ackFrom(failed), null, 'a failed canonical transaction publishes no ACK');
      assert.ok(failed.errors.some((error) => error.includes('ledger fault')));
      assert.ok(!failed.visited.includes(ACK_QUEUE), 'no retryable ACK is queued');
      f.first.exec('DROP TRIGGER fail_issue233_ledger');
      assert.deepEqual(terminalSnapshot(f.first), beforeFault,
        'R04 rolls back links, claim, primary, both versions, outbox, ledger and REST ACK');
      return;
    }
    const first = await cloudCall(profile, f, command(), { policy });
    assert.equal(ackFrom(first).result, 'APPLIED');
    const before = f.first.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
    if (id === 'R02') {
      const changed = command();
      changed.payload.commandType = undefined;
      const result = await cloudCall(profile, f, changed, { policy });
      if (policy) {
        assert.deepEqual(ackFrom(result), ackFrom(first));
        assert.deepEqual(result.errors, []);
        assert.fail('MUTANT_BINDING');
      }
      assert.equal(ackFrom(result), null);
      assert.ok(result.errors.some((error) => error.includes('command_id_binding_conflict')));
      assert.equal(ackRows(f.first).length, 1, 'the stored ACK stays the only pending REST ACK');
    } else if (id === 'R01') {
      const result = await cloudCall(profile, f, command(), { policy });
      const refused = result.errors.find((error) => error.startsWith(DEDUPE + ': '));
      assert.equal(refused, undefined,
        'R01 the generic replay check never answers the bound replay (MUTANT_GATE_ROUTE): ' + refused);
      assert.ok(result.gate.length === 1 && result.gate[0].slot === 1 && result.dedupe.length === 0,
        'the gate sends the replay past the generic replay check to its owner');
      assert.equal(result.mqtt.length, 1);
      assert.equal(result.mqtt[0].payload, first.mqtt[0].payload, 'exact replay republishes the stored ACK byte-for-byte');
      assert.equal(ackRows(f.first).length, 1);
    } else if (id === 'R03') {
      let postReclaimOutbox = null;
      const result = await cloudCall(profile, f, command(124, 9), {
        policy,
        beforeBegin() {
          f.second.prepare('UPDATE devices SET user_id=?,sync_version=? WHERE deveui=?').run(4, 8, DEVICE);
          postReclaimOutbox = f.second.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all().map((row) => ({ ...row }));
        }
      });
      assert.ok(postReclaimOutbox && postReclaimOutbox.length > before, 'the second connection reclaim creates its own outbox event');
      assert.equal(ackFrom(result).result, 'CONFLICT');
      assert.equal(ackFrom(result).reasonCode, 'stale_device_state');
      assert.equal(deviceState(f.first).user_id, 4);
      assert.deepEqual(f.first.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all().map((row) => ({ ...row })),
        postReclaimOutbox, 'R03 command adds no event after the second connection reclaim');
    }
    if (id !== 'R03') assert.equal(f.first.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, before);
  } finally {
    f.close();
  }
}

async function accountCase(profile) {
  const f = fixture();
  try {
    const libs = libsFor(profile, productionFacade(f.first));
    const before = {
      device: deviceState(f.first),
      links: assignments(f.first),
      historical: historyRows(f.first),
      weatherEvents: weatherEvents(f.first),
      state: weatherVersion(f.first)
    };
    const call = await executeFunction(loadNode('al-unlink-db', profile.flowsPath),
      Object.assign({ msg: { _unlinkAuth: { userId: 1, username: 'admin1' } }, db: f.first }, libs));
    assert.ok(call.result[0]);
    const format = await executeFunction(loadNode('al-unlink-format', profile.flowsPath),
      Object.assign({ msg: call.result[0], db: f.first }, libs));
    assert.equal(format.result.statusCode, 200);
    assert.deepEqual(format.result.payload, { success: true });
    assert.equal(f.first.prepare("SELECT linked FROM sync_link_state WHERE peer_node='cloud'").get().linked, 0);
    assert.deepEqual(deviceState(f.first), before.device);
    assert.deepEqual(assignments(f.first), before.links);
    assert.deepEqual(historyRows(f.first), before.historical);
    assert.deepEqual(weatherEvents(f.first), before.weatherEvents);
    assert.equal(weatherVersion(f.first), before.state);
  } finally {
    f.close();
  }
}

// H01: the local DELETE /api/devices/:deveui keeps today's behavior in both flag states. The
// held Phase B all-links cleanup does not run there: links, weather version, weather events and
// history are unchanged while claim and primary are cleared.
async function boundaryCase(profile, policy) {
  const owner = policy || policyFor(profile);
  assert.equal(owner.CLOUD_S2120_UNCLAIM, undefined, 'the cloud-only cleanup flag is not exported');
  assert.ok(!fs.readFileSync(path.join(profile.nodeRedModules, 'osi-irrigation-policy', 'routes.js'), 'utf8')
    .includes('CLOUD_S2120_UNCLAIM'), 'no route can set the cloud-only cleanup flag');
  for (const scoped of [true, false]) {
    const f = fixture();
    try {
      const before = {
        links: assignments(f.first),
        state: weatherVersion(f.first),
        weather: weatherEvents(f.first).length,
        history: historyRows(f.first)
      };
      const result = await traverse(profile, 'scoped-device-delete-router', {
        req: { method: 'DELETE', headers: { authorization: auth(1, 'admin1') }, params: { deveui: DEVICE } },
        payload: {}
      }, f.first, { scoped, policy });
      assertOneResponse(result, 200, 'H01 local unclaim, scoped=' + scoped);
      const device = deviceState(f.first);
      assert.equal(device.user_id, null);
      assert.equal(device.irrigation_zone_id, null);
      assert.deepEqual(assignments(f.first), before.links,
        'H01 the held Phase B local all-links cleanup did not run: weather links unchanged');
      assert.equal(weatherVersion(f.first), before.state);
      assert.equal(weatherEvents(f.first).length, before.weather);
      assert.deepEqual(historyRows(f.first), before.history);
      assert.equal(f.first.prepare(
        "SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_key=? AND op='DEVICE_UNCLAIMED'"
      ).get(DEVICE).n, 1);
      assert.equal(f.first.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 0);
    } finally {
      f.close();
    }
  }
}

// G01: the four protected WATERMARK command types pass the gate with no helper load and the
// identical message on output 1; the generic replay node then sends them to its protected
// output 3, still before any helper load.
const PROTECTED_TYPES = [
  'SET_WATERMARK_CALIBRATION', 'DELETE_WATERMARK_CALIBRATION', 'SET_CHAMELEON_CONFIG', 'UPSERT_DEVICE_SOIL_DEPTHS'
];

async function protectedPassCase(profile) {
  const raw = new DatabaseSync(':memory:');
  try {
    const gateNode = loadNode(GATE, profile.flowsPath);
    assert.deepEqual(gateNode.wires[0], [DEDUPE], 'G01 gate output 1 feeds the generic replay check');
    for (const type of PROTECTED_TYPES) {
      const envelope = { commandId: 77, commandType: type, aggregateType: 'DEVICE', aggregateKey: NONWEATHER, payload: { deviceEui: NONWEATHER } };
      const msg = { payload: { commandId: 77, commandType: type, leasedToGateway: GATEWAY, _pendingCommandEnvelope: envelope } };
      const pristine = JSON.stringify(msg.payload);
      const requests = [];
      const osiLib = { require(name) {
        requests.push(name);
        return { ok: false, error: 'G01 expects no helper load: ' + name };
      } };
      const options = { db: raw, env: { DEVICE_EUI: GATEWAY }, nodeRedModules: profile.nodeRedModules, libOverrides: { osiLib } };
      const gate = await executeFunction(gateNode, Object.assign({ msg }, options));
      assert.deepEqual(requests, [], 'G01 ' + type + ': the gate loads no helper');
      assert.ok(Array.isArray(gate.result) && gate.result.length === 2 && gate.result[0] === msg && gate.result[1] === null,
        'G01 ' + type + ': the gate passes the identical message on output 1 only');
      assert.deepEqual([gate.errors, gate.warnings], [[], []], 'G01 ' + type + ': the gate reports nothing');
      assert.equal(JSON.stringify(msg.payload), pristine, 'G01 ' + type + ': the gate changes neither the command nor its envelope');
      const dedupe = await executeFunction(loadNode(DEDUPE, profile.flowsPath), Object.assign({ msg: gate.result[0] }, options));
      assert.deepEqual(requests, [], 'G01 ' + type + ': the replay node reaches its protected output before any helper load');
      assert.ok(Array.isArray(dedupe.result) && dedupe.result.length === 3 &&
        dedupe.result[0] === null && dedupe.result[1] === null && dedupe.result[2] === msg,
        'G01 ' + type + ': the replay node sends the identical message to its protected output 3');
      assert.deepEqual([dedupe.errors, dedupe.warnings], [[], []], 'G01 ' + type + ': the replay node reports nothing');
    }
  } finally {
    raw.close();
  }
}

// G02 and G03 call the owner gate (routes.s2120UnclaimGate) with a recording DB helper and node,
// so opens, queries, closes, errors and warnings land in one ordered log.
function pendingUnclaim(deviceEui, aggregateKey) {
  const issued = command();
  issued.aggregateKey = aggregateKey;
  issued.payload.deviceEui = deviceEui;
  return Object.assign({}, issued, {
    _pendingCommandEnvelope: {
      commandId: issued.commandId, commandType: issued.commandType, eventUuid: issued.eventUuid,
      aggregateType: issued.aggregateType, aggregateKey, appliedSyncVersion: issued.appliedSyncVersion,
      effectKey: null, payload: issued.payload
    }
  });
}

function recordingDatabase(raw, log, fault) {
  const base = facadeDb(raw);
  const counts = { opens: 0, closes: 0 };
  function Database(file) {
    if (fault.construct) throw fault.construct;
    counts.opens++;
    log.push('open ' + file);
    return {
      all(sql, params) {
        log.push('all');
        if (fault.query) return Promise.reject(fault.query);
        return base.all(sql, params).then((rows) => {
          log.push('rows');
          return rows;
        });
      },
      close(callback) {
        counts.closes++;
        log.push('close');
        setImmediate(() => callback(fault.close || null));
      }
    };
  }
  return { Database, counts };
}

function ownerGateContext(profile, raw, cmd, fault = {}) {
  const log = [];
  const requests = [];
  const db = recordingDatabase(raw, log, fault);
  const msg = { payload: cmd };
  const node = {
    error: (text, errorMsg) => log.push(['error', String(text), errorMsg === msg]),
    warn: (text) => log.push(['warn', String(text)])
  };
  const osiLib = { require(name) {
    requests.push(name);
    if (name !== 'osi-db-helper') return { ok: false, error: 'unexpected helper ' + name };
    return fault.dbHelper ? { ok: false, error: fault.dbHelper } : { ok: true, value: { Database: db.Database } };
  } };
  const policy = policyFor(profile);
  return {
    log, requests, counts: db.counts, msg, cmd,
    context: { msg, node, osiLib, policy, command: cmd, envelope: cmd._pendingCommandEnvelope }
  };
}

const OPEN = 'open /data/db/farming.db';

async function ownerGateOrderCase(profile) {
  const f = fixture();
  try {
    const policy = policyFor(profile);
    const cantOpen = Object.assign(new Error('SQLITE_CANTOPEN: unable to open database file'), { code: 'SQLITE_CANTOPEN' });
    const closeFault = new Error('fixture close failed');
    const cases = [
      { label: 'station', cmd: pendingUnclaim(DEVICE, DEVICE), out: 'owner', log: [OPEN, 'all', 'rows', 'close'] },
      { label: 'non-station', cmd: pendingUnclaim(NONWEATHER, NONWEATHER), out: 'replay', log: [OPEN, 'all', 'rows', 'close'] },
      { label: 'no identity', cmd: pendingUnclaim('not-an-eui', null), out: 'replay', log: [OPEN, 'close'] },
      {
        // The real osi-db-helper Database reports an open failure through its queued queries,
        // not from the constructor; the awaited lookup rejects inside the owner gate's try.
        label: 'asynchronous open rejection', cmd: pendingUnclaim(DEVICE, DEVICE), fault: { query: cantOpen }, out: 'none',
        log: [OPEN, 'all', ['error', 'S2120 unclaim check failed closed: ' + cantOpen.message, true], 'close']
      },
      {
        label: 'close failure after a station lookup', cmd: pendingUnclaim(DEVICE, DEVICE), fault: { close: closeFault }, out: 'owner',
        log: [OPEN, 'all', 'rows', 'close', ['warn', 'S2120 unclaim check DB close failed: fixture close failed']]
      },
      {
        label: 'close failure after a lookup failure', cmd: pendingUnclaim(DEVICE, DEVICE), fault: { query: cantOpen, close: closeFault }, out: 'none',
        log: [OPEN, 'all', ['error', 'S2120 unclaim check failed closed: ' + cantOpen.message, true], 'close',
          ['warn', 'S2120 unclaim check DB close failed: fixture close failed']]
      }
    ];
    for (const spec of cases) {
      const g = ownerGateContext(profile, f.first, spec.cmd, spec.fault);
      const result = await policy.routes.s2120UnclaimGate(g.context);
      const expected = { owner: [null, g.msg], replay: [g.msg, null], none: [null, null] }[spec.out];
      assert.ok(Array.isArray(result) && result.length === 2 && result[0] === expected[0] && result[1] === expected[1],
        'G02 ' + spec.label + ': output ' + spec.out);
      assert.deepEqual(g.log, spec.log, 'G02 ' + spec.label + ': open, lookup, report and close order');
      assert.deepEqual(g.counts, { opens: 1, closes: 1 }, 'G02 ' + spec.label + ': one open and exactly one close');
      assert.deepEqual(g.requests, ['osi-db-helper'], 'G02 ' + spec.label + ': the owner gate loads only the DB helper');
      assert.equal(g.context.envelope.leasedToGateway, GATEWAY, 'G02 ' + spec.label + ': the trusted lease joins the envelope');
    }
    assert.deepEqual(terminalSnapshot(f.first).ledger, [], 'G02 the owner gate writes no ledger row');
  } finally {
    f.close();
  }
}

async function ownerGateRefusalCase(profile) {
  const f = fixture();
  try {
    const policy = policyFor(profile);
    const before = terminalSnapshot(f.first);
    // DB helper unavailable inside the owner gate: one error, no output, no open.
    const missing = ownerGateContext(profile, f.first, pendingUnclaim(DEVICE, DEVICE), { dbHelper: 'fixture db helper quarantined' });
    const refused = await policy.routes.s2120UnclaimGate(missing.context);
    assert.ok(Array.isArray(refused) && refused.length === 2 && refused[0] === null && refused[1] === null, 'G03 missing DB helper: no output');
    assert.deepEqual(missing.log, [['error', 'S2120 unclaim owner unavailable: fixture db helper quarantined', true]],
      'G03 missing DB helper: one contextual error');
    assert.deepEqual(missing.counts, { opens: 0, closes: 0 }, 'G03 missing DB helper: no open');
    // Owner unavailable at the gate node: one error, no output, no DB helper load.
    const gateNode = loadNode(GATE, profile.flowsPath);
    const requests = [];
    const policyMissing = { require(name) {
      requests.push(name);
      return name === 'osi-irrigation-policy' ? { ok: false, error: 'fixture policy quarantined' } : { ok: false, error: 'unexpected helper ' + name };
    } };
    const msg = { payload: pendingUnclaim(DEVICE, DEVICE) };
    const gate = await executeFunction(gateNode, {
      msg, db: f.first, nodeRedModules: profile.nodeRedModules, libOverrides: { osiLib: policyMissing }
    });
    assert.ok(Array.isArray(gate.result) && gate.result.length === 2 && gate.result[0] === null && gate.result[1] === null,
      'G03 missing owner: no output');
    assert.deepEqual([gate.errors, gate.warnings], [['S2120 unclaim owner unavailable: fixture policy quarantined'], []],
      'G03 missing owner: one contextual error');
    assert.deepEqual(requests, ['osi-irrigation-policy'], 'G03 missing owner: no DB helper load, so no open');
    // A DB helper whose constructor throws synchronously: the constructor runs before the owner
    // gate's try, so the returned promise rejects with that error. There is no contextual error,
    // no warning, no open and no close, and no output; Node-RED reports the rejection itself.
    const constructError = new Error('fixture constructor failed');
    const thrown = ownerGateContext(profile, f.first, pendingUnclaim(DEVICE, DEVICE), { construct: constructError });
    await assert.rejects(policy.routes.s2120UnclaimGate(thrown.context), (error) => error === constructError,
      'G03 synchronous constructor failure rejects the owner gate promise');
    assert.deepEqual(thrown.log, [], 'G03 synchronous constructor failure: no report, open or close from the owner gate');
    assert.deepEqual(thrown.counts, { opens: 0, closes: 0 });
    const throwing = { Database: function Database() { throw constructError; } };
    await assert.rejects(executeFunction(gateNode, {
      msg: { payload: pendingUnclaim(DEVICE, DEVICE) }, db: f.first, nodeRedModules: profile.nodeRedModules,
      osiLibModules: { 'osi-db-helper': throwing, 'osi-irrigation-policy': policy }
    }), (error) => error === constructError, 'G03 the gate node passes the rejection to Node-RED and sends nothing');
    assert.deepEqual(terminalSnapshot(f.first), before, 'G03 no refusal writes a row');
  } finally {
    f.close();
  }
}

// L01, L02: a persistent osi-command-ledger load failure along the real chain from
// sync-pending-split. A live S2120 unclaim passes the gate on output 2 and stops at the lifecycle
// adapter; any other unclaim passes on output 1 and stops at the generic replay node. Neither
// applies the unclaim, writes a ledger decision or sends an ACK.
const LEDGER_FAULT = 'fixture ledger quarantined';
const MISSING_LEDGER = {
  L01: { gateSlot: 1, stop: ADAPTER, forbidden: DEDUPE, error: ADAPTER + ': lifecycle command adapter unavailable: ' + LEDGER_FAULT },
  L02: { gateSlot: 0, stop: DEDUPE, forbidden: ADAPTER, error: DEDUPE + ': Command helpers unavailable: ' + LEDGER_FAULT }
};

async function missingLedgerRun(profile, id, inject) {
  const f = fixture();
  try {
    const issued = command();
    if (id === 'L02') {
      issued.aggregateKey = NONWEATHER;
      issued.payload.deviceEui = NONWEATHER;
      issued.payload.syncVersion = issued.appliedSyncVersion = 3;
    }
    const before = terminalSnapshot(f.first);
    const loader = { fault: inject ? { name: 'osi-command-ledger', error: LEDGER_FAULT } : null, requests: [] };
    const call = await cloudCall(profile, f, issued, { loader });
    return { call, before, after: terminalSnapshot(f.first), requests: loader.requests };
  } finally {
    f.close();
  }
}

function missingLedgerOracles(profile, id, run) {
  const spec = MISSING_LEDGER[id];
  const { call } = run;
  return {
    stop() {
      const gate = call.trace.filter((item) => item.id === GATE);
      assert.ok(gate.length === 1 && gate[0].slot === spec.gateSlot, id + ' stop: the gate emits once, on output ' + (spec.gateSlot + 1));
      assert.ok(call.visited.includes(spec.stop), id + ' stop: the chain reaches ' + spec.stop);
      assert.equal(call.trace.filter((item) => item.id === spec.stop).length, 0, id + ' stop: ' + spec.stop + ' emits nothing');
      assert.ok(!call.visited.includes(spec.forbidden), id + ' stop: the chain never reaches ' + spec.forbidden);
    },
    error() {
      assert.deepEqual(call.errors, [spec.error], id + ' error: exactly one contextual error, at the stop node');
      assert.ok(!call.warnings.some((warning) => warning.includes('S2120 unclaim held') || warning.includes(LEDGER_FAULT)),
        id + ' error: no hold and no second report');
    },
    state() {
      assert.deepEqual(run.after, run.before, id + ' state: no device, zone, weather, history, outbox, ledger or REST ACK row changes');
      const kinds = call.visited.map((nodeId) => loadNode(nodeId, profile.flowsPath).type);
      assert.ok(call.responses.length === 0 && call.mqtt.length === 0 && call.legacy.length === 0 &&
        !kinds.includes('http request'), id + ' state: no HTTP response, MQTT ACK, legacy SQL or external request');
    }
  };
}

async function missingLedgerCase(profile, id) {
  const run = await missingLedgerRun(profile, id, true);
  const oracles = missingLedgerOracles(profile, id, run);
  oracles.stop();
  oracles.error();
  oracles.state();
  assert.deepEqual(run.requests.filter((item) => item.name === 'osi-command-ledger').map((item) => item.node),
    [MISSING_LEDGER[id].stop], id + ': the quarantined ledger was requested, once, by the stop node');
  assert.deepEqual(run.requests.filter((item) => item.node === GATE).map((item) => item.name),
    ['osi-irrigation-policy', 'osi-db-helper'], id + ': the gate loads only the owner and the DB helper');
}

// Control: the same chain with the injector disconnected. Every oracle of the negative case must
// fail, and normal ledger resolution must reach the existing APPLIED outcome.
async function missingLedgerControl(profile, id) {
  const run = await missingLedgerRun(profile, id, false);
  const oracles = missingLedgerOracles(profile, id, run);
  for (const part of ['stop', 'error', 'state']) {
    await assert.rejects(async () => oracles[part](),
      (error) => error.name === 'AssertionError' && error.message.startsWith(id + ' ' + part + ':'),
      id + ' control: without the injected fault the ' + part + ' oracle fails');
  }
  const ack = ackFrom(run.call);
  assert.ok(ack && ack.result === 'APPLIED', id + ' control: normal ledger resolution applies the unclaim');
  const ledgerNodes = run.requests.filter((item) => item.name === 'osi-command-ledger').map((item) => item.node);
  assert.equal(ledgerNodes[0], MISSING_LEDGER[id].stop, id + ' control: the same node asks for the ledger first');
  if (id === 'L01') {
    assert.ok(run.call.trace.some((item) => item.id === ADAPTER && item.slot === 2), 'L01 control: the owner answers on the S2120 output');
    assert.deepEqual(run.after.joins, [], 'L01 control: the owner removes every weather link');
  } else {
    assert.ok(run.call.visited.includes(ACK_QUEUE), 'L02 control: the generic path queues its ACK');
    assert.equal(run.after.devices.find((row) => row.deveui === NONWEATHER).user_id, null, 'L02 control: the generic unclaim applies');
  }
}

let passed = 0;
const candidate = PROFILES.every((profile) => typeof policyFor(profile).applyS2120CloudUnclaim === 'function');
for (const profile of PROFILES) {
  const label = profile.name;
  if (!candidate) {
    for (const spec of [D[0], D[3]]) test(label + ' RED ' + spec.id, async () => {
      await detachCase(profile, spec);
    });
    test(label + ' RED C01', async () => {
      await cloudCase(profile, 'C01');
    });
    continue;
  }
  for (const spec of D) test(label + ' ' + spec.id, async () => {
    await detachCase(profile, spec);
    if (spec.id === 'D12') await unlinkedDetachCase(profile);
    passed++;
  });
  for (let n = 1; n <= 12; n++) {
    const id = 'C' + String(n).padStart(2, '0');
    test(label + ' ' + id, async () => {
      await cloudCase(profile, id);
      passed++;
    });
  }
  for (let n = 1; n <= 4; n++) {
    const id = 'R0' + n;
    test(label + ' ' + id, async () => {
      await replayCase(profile, id);
      passed++;
    });
  }
  test(label + ' F01', async () => {
    await forceDeliveryCase(profile);
    passed++;
  });
  test(label + ' A01', async () => {
    await accountCase(profile);
    passed++;
  });
  test(label + ' H01', async () => {
    await boundaryCase(profile);
    passed++;
  });
  test(label + ' G01', async () => {
    await protectedPassCase(profile);
    passed++;
  });
  test(label + ' G02', async () => {
    await ownerGateOrderCase(profile);
    passed++;
  });
  test(label + ' G03', async () => {
    await ownerGateRefusalCase(profile);
    passed++;
  });
  for (const id of ['L01', 'L02']) {
    test(label + ' ' + id, async () => {
      await missingLedgerCase(profile, id);
      passed++;
    });
    test(label + ' ' + id + ' control', async () => {
      await missingLedgerControl(profile, id);
      passed++;
    });
  }
  for (let n = 0; n < 6; n++) test(label + ' mutation ' + n, async () => {
    const policy = n < 4 ? mutantPolicy(profile, MUTATIONS[n]) : mutantRoutesPolicy(profile, ROUTE_MUTATIONS[n - 4]);
    await assert.rejects(async () => {
      if (n === 0) await detachCase(profile, D[0], policy);
      if (n === 1) await detachCase(profile, D[4], policy);
      if (n === 2 || n === 4) await cloudCase(profile, 'C01', policy);
      if (n === 3) await replayCase(profile, 'R02', policy);
      if (n === 5) await replayCase(profile, 'R01', policy);
    }, (error) => error.name === 'AssertionError' && KILLS[n].every((text) => error.message.includes(text)));
    passed++;
  });
}
if (candidate) test('issue233 phase A count', () => {
  assert.equal(passed, 88);
  process.stdout.write('PASS 88 issue-233 phase-a checks\n');
});
~~~

## 12. Case matrix and forecast

Per profile: 12 D, 12 C, 4 R, F01, A01, H01, G01 to G03, L01, L01 control, L02, L02 control and six mutations, 44 tests. Both profiles give 88, plus one count test: **89 TAP subtests**, custom line `PASS 88 issue-233 phase-a checks`. The count is fixed by the loops: `D` has 12 entries, the C loop runs 1 to 12, the R loop 1 to 4, the L loop two ids with two tests each, and the mutation loop 0 to 5. The proposal's 35 per profile (70 checks, 71 TAP) is superseded. All UNRUN.

| Cases | Required result |
|---|---|
| D01 to D12, C01 to C12, R01 to R04, A01, H01 | As accepted in the U plan. Deferral assertions read "gate output 2 and no dedupe emission"; C08 also asserts gate output 1 with the identical split message and the stamped lease. C01 to C07, C11 and C12 assert that no `S2120 unclaim held` warning appears. R01 asserts that the generic replay node reports nothing. |
| F01 | Real `sync-force-build` with a pending-commands mock returning the S2120 unclaim: the queued message carries the lease beside an unstamped envelope; from `reject-indefinite-open` the gate emits on output 2 with the stamped lease, dedupe emits nothing, one APPLIED ACK, no weather links left. |
| G01 | For each of the four protected types: the real gate node makes no loader call and returns the identical message on output 1 only, reports nothing and leaves the command unchanged; the real dedupe node then returns it on output 3 with still no loader call. |
| G02 | The real `routes.s2120UnclaimGate` with a recording DB helper and node: station, non-station and no-identity outputs; asynchronous open rejection; close failure after a station lookup and after a lookup failure. Each asserts the exact ordered log of open, query, rows, error, close and warning, one open and one close, only `osi-db-helper` loaded, and the stamped lease. No ledger row. |
| G03 | Missing DB helper: one error, no output, no open. Missing owner at the real gate node: one error, no output, only `osi-irrigation-policy` requested. Constructor throw: the owner gate promise rejects with that error with an empty log, and the real gate node rejects too. No row changes. |
| L01, L02 | Fresh fixture, entry at `sync-pending-split`, `osi-command-ledger` answers `{ok:false,error:'fixture ledger quarantined'}` on every request. Stop oracle: gate output 2 (L01) or 1 (L02), the stop node reached and silent, the other node never reached. Error oracle: exactly one error, `conditional-lifecycle-command-adapter: lifecycle command adapter unavailable: fixture ledger quarantined` (L01) or `command-dedupe-dispatch: Command helpers unavailable: fixture ledger quarantined` (L02), no hold warning. State oracle: the full `terminalSnapshot` (devices, zones, weather joins and state, history, `sync_outbox`, `applied_commands`, `command_ack_outbox`) unchanged; no HTTP response, MQTT ACK, legacy SQL or `http request` node. The ledger was requested once, by the stop node; the gate requested `osi-irrigation-policy` and `osi-db-helper` only. |
| L01 control, L02 control | Same chain, injector disconnected (requests still recorded). Each of the three oracles must throw an `AssertionError` whose message starts with its own label (`L01 stop:` and so on). Normal resolution reaches APPLIED: L01 through the owner (adapter output 3, no links left), L02 through the generic path (ACK queue visited, device unclaimed). The stop node is the first to request the ledger. |

Mutations, each run on one named case. A mutant counts as killed only by an `AssertionError` whose message holds every listed text.

| Id | Target | Edit (in-memory copy, injected as that profile's `osi-irrigation-policy`) | Case | Kill texts |
|---|---|---|---|---|
| M0 | `lifecycle.js` | selected-pair DELETE made a no-op | D01 | `MUTANT_PAIR_DELETE` |
| M1 | `lifecycle.js` | first weather state inserted at 1 | D05 | `MUTANT_FIRST_STATE` |
| M2 | `lifecycle.js` | cloud weather cleanup moved after the device UPDATE | C01 | `MUTANT_EVENT_ORDER` |
| M3 | `lifecycle.js` | binding hash comparison disabled | R02 | `MUTANT_BINDING` |
| M4 | `routes.js` | the lease stamp line deleted | C01 | `MUTANT_LEASE` and `lease_gateway_unavailable_or_mismatch` (the adapter's hold warning) |
| M5 | `routes.js` | the owner gate returns output 1 for a station | R01 | `MUTANT_GATE_ROUTE` and `command-dedupe-dispatch: Command dedupe failed closed: WATERMARK command replay binding conflicts with the terminal ledger` (the bound-replay refusal, `osi-command-ledger/index.js:646-653`) |

M4 and M5 compile a changed copy of the profile's `routes.js` and return the real policy with `routes` replaced, so the gate node, the adapter and the owner's own `osiLib.require('osi-irrigation-policy')` all reach the mutant. Under M5 the first delivery still applies through the generic replay node and the adapter; the replay then reaches the generic node, which refuses the bound row before the owner can replay its ACK.

**RED at the Stage 1 commit (B product).** Only behavior failures named here count; any other failure, including an import, setup, fixture or dependency failure, makes RED inconclusive and stops.

| Command | Forecast |
|---|---|
| `10-red-focused` | Candidate mode keys on `applyS2120CloudUnclaim`, absent at B, so the file registers six tests: `RED D01`, `RED D04`, `RED C01` per profile; `# tests 6`, `# fail 6`. D01 fails on `selected weather pair removed, other pairs kept (MUTANT_PAIR_DELETE)`; D04 on its status (404, `lifecycle.js:454-455` at B); C01 on `cloud S2120 unclaim removes every weather link`. C01 passes the new hold check first, because B never emits `S2120 unclaim held`. |
| `11-red-wiring` | Exit 1, `FAIL: 5 flow wiring regression(s):`, in this order: `S2120 unclaim gate: every guarded cloud command must pass the issue #233 owner gate before the generic replay check, and only the owner may send it past that check`; `conditional peer: sync-outbox-build must build each peer database through replication.flowPeerDb with its own rollback label`; the same for `sync-force-build`; the T1 adapter line; `S2120 unclaim helper failure: gate: node source is unavailable`. |
| `12-red-binding` | Exactly one failing test, `accepts the complete approved function-node surfaces`, on `missing approved node s2120-unclaim-gate`. |
| `13-red-cond-flow` | The bcm2712 outputs assertion (`bcm2712: lifecycle adapter has raw fallback, durable ACK and S2120 unclaim ACK outputs`) fails first; no `issue 233 lifecycle adapter outputs and wires checked` line appears. |
| `14-red-backoff` | The real SELECT extraction rejects the missing rowid tie-break. |
| `15-red-replication` | Through `scripts/run-module-tests.js` with both profile copies: six failing tests, the three RT1 tests per profile, each on `replication.flowPeerDb is not a function`. Every other test in both files passes. |

The generators test (`migrate-flows-journal-generators.test.js`) is not RED: dedupe and both literals equal B. Historical U RED evidence, including U RED 13, which reached only the outputs assertion, admits none of these pins. The six RED commands do not cover V1, V2, T9's GREEN side, G01 to G03, L01, L02 or M4 and M5; GREEN gates 30, 31, 35 and 57 do; gate 60 covers the helper-absent builders.

**GREEN at the Stage 2 commit**, each exit 0 with its signal: 29 `ISSUE233_DEPS_OK green`; 30 `PASS 88 issue-233 phase-a checks`, `# pass 89`, `# fail 0`; 31 ends `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed` with no `FAIL:` line, and prints `OK  S2120 unclaim gate runs before the generic replay check; only the irrigation-policy owner sends a command past it`; 33 `# fail 0` with two lines `OK bcm2712: issue 233 lifecycle adapter outputs and wires checked` and `OK bcm2709: …`, which show that both the outputs and the wires assertion ran in both profiles; 35 `Sync flow verification passed` then `All parity checks passed.`, with `OK DB helper source present despite missing local runtime deps` on the unresolved native `sqlite3` branch; 36 `verify-flows-fn-parse: OK`; 38 `All parity checks passed.`; 40 `OK <profile flows path> (total 1616317)` for each profile, two `NOTE … below committed baseline 1617691` lines and `verify-flows-size-ratchet: OK (HEAD total 3232634, 0eaa6d87892708c66f5a004bf121656c5a52b17e total 3235382; committed baseline not exceeded)`; 41 `verify-test-inventory: OK (`; 56 an `OK [<profile>] … osi-lib caller names are registered` line per profile; 58 `verify-flows-output-arity: OK`; 59 `verify-request-context-isolation: OK`; 61 no output, exit 0; every `node --test` gate `# fail 0`. Gate 53 covers built-in patterns only; the private name list is not available.

Failure classes. A behavior failure is one of the named assertions above. An import failure is a module load or syntax error in a product or test file. A setup failure is anything in the fixture's own seed, harness, mock, loader injection or file handling. Only behavior failures can be RED evidence; import and setup failures stop the stage as inconclusive and need an amendment, not a product change. A missing execution prerequisite is a setup failure.

## 13. Plan commit, stages and commands (all UNRUN)

Every external program runs from the isolated edge execution worktree through `python3 C/run-heavy.py` and the capture `reports/capture-guard-resume-20261030-1216.py` (SHA-256 `e26fde69a8181e5d2e4ad0bed3f828eb3a8c89b68b6da29795c2c2654ffe8a8e`, bound by `reports/capture-guard-resume-20261030-1216-binding.json`, SHA-256 `a8c7b15831740d8b950a9d85407e4dfac8e6a89c4f0c669ac3b04d1a3803fff0`). No option goes before the wrapper script, and no outer wrapper surrounds this recipe: each `cap` is one run-heavy launch. A guard restart retires this capture; a stage then needs a reviewed successor capture with its own binding. The capture boundary, observer bound, `TMPDIR` rule and session variables (`STAGE`, `W`, `T`) are those of the U plan's section 12, unchanged.

[[RECIPE-HEADER]]
~~~sh
set -u
export GIT_NO_LAZY_FETCH=1
C=/home/phil/projects/osi-release-campaign-2026-10-25
A="$C/reports/issue-233-w-extraction-packet-r1/packet"
B=0eaa6d87892708c66f5a004bf121656c5a52b17e
: "${STAGE:?plan, setup, tests or product}" "${W:?literal execution worktree path}"
R="$C/reports/issue-233-phase-a-execute-r7-$STAGE"
X="$R.wrapper-exits.txt"
D="$C/reports/issue-233-phase-a-execute-r7-setup.deps.json"
ID='-c user.name=Project-OSI -c user.email=philippe.hess@opensmartirrigation.org'
if [ -e "$R" ] || [ -e "$X" ]; then printf 'receipt root exists: %s\n' "$R"; exit 1; fi
cap() {
  label=$1; secs=$2; shift 2
  python3 "$C/run-heavy.py" python3 "$C/reports/capture-guard-resume-20261030-1216.py" --worktree "$W" --receipt-dir "$R/$label" --label "$label" --timeout-seconds "$secs" -- "$@"
  rc=$?
  printf 'CAP %s %s\n' "$label" "$rc" >> "$X" || return 125
  return "$rc"
}
need() { cap "$@" || { printf 'STOP %s\n' "$1" >> "$X"; exit 1; }; }
red() { cap "$@"; rc=$?; printf 'RED %s %s\n' "$1" "$rc" >> "$X" || exit 1; }
gate() { cap "$@"; rc=$?; printf 'GATE %s %s\n' "$1" "$rc" >> "$X" || exit 1; [ "$rc" -eq 0 ] || GATE_FAILED=1; }
fresh() {
  need "$1-fetch" 120 env GIT_TERMINAL_PROMPT=0 git -c credential.helper= fetch --no-tags --refmap= origin main
  need "$1-main" 60 python3 -I -c 'import subprocess,sys
head=subprocess.check_output(["git","rev-parse","FETCH_HEAD"],text=True).strip()
print("FETCH_HEAD "+head)
sys.exit(0 if head==sys.argv[1] else 3)' "$B"
}
commitcheck() {
  label=$1; parent=$2; shift 2
  need "$label" 60 python3 -I -c 'import subprocess,sys
parent=sys.argv[1]; want=sorted(sys.argv[2:])
g=lambda *a: subprocess.check_output(["git",*a],text=True)
head=g("rev-parse","HEAD").strip()
row=g("rev-list","--parents","-n","1",head).split()
assert row==[head,parent], ("parent",row)
names=sorted(x for x in g("diff","--name-only",parent,head).splitlines() if x)
assert names==want, ("paths",names)
assert g("status","--porcelain","--untracked-files=all")=="", "dirty worktree"
print("COMMIT_OK "+head)' "$parent" "$@"
}
EDRUN='import fcntl,hashlib,os,sys
p=sys.argv[1]; want=os.environ["ISSUE233_ACCEPTED_EDITOR_SHA256"]
data=open(p,"rb").read()
got=hashlib.sha256(data).hexdigest()
if got!=want:
    print("ISSUE233_EDITOR_DIGEST_MISMATCH "+got,file=sys.stderr); sys.exit(6)
print("ISSUE233_EDITOR_DIGEST_OK "+got,flush=True)
try:
    fd=os.memfd_create("issue233-editor",os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
    if fd<3: raise OSError("memfd took standard descriptor "+str(fd))
    view=memoryview(data); n=0
    while n<len(data):
        k=os.write(fd,view[n:])
        if k<=0: raise OSError("write returned "+str(k)+" at byte "+str(n))
        n+=k
    mask=fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE|fcntl.F_SEAL_SEAL
    fcntl.fcntl(fd,fcntl.F_ADD_SEALS,mask)
    os.lseek(fd,0,os.SEEK_SET); back=b""
    while True:
        chunk=os.read(fd,65536)
        if not chunk: break
        back+=chunk
    if back!=data or os.fstat(fd).st_size!=len(data): raise OSError("sealed copy differs from the verified bytes")
    os.lseek(fd,0,os.SEEK_SET)
    os.dup2(fd,0,inheritable=True); os.close(fd)
    if os.lseek(0,0,os.SEEK_CUR)!=0 or not os.get_inheritable(0): raise OSError("stdin is not rewound and inheritable")
    if fcntl.fcntl(0,fcntl.F_GET_SEALS)&mask!=mask: raise OSError("stdin seals missing")
except (AttributeError,OSError) as e:
    print("ISSUE233_EDITOR_TRANSPORT_FAILED "+repr(e),file=sys.stderr); sys.exit(11)
print("ISSUE233_EDITOR_STDIN_SEALED "+got+" "+str(len(data)),flush=True)
try:
    os.execvp("node",["node","-"])
except OSError as e:
    print("ISSUE233_EDITOR_TRANSPORT_FAILED exec "+repr(e),file=sys.stderr); sys.exit(11)'
DEPS='import hashlib,json,os,pathlib,re,shutil,subprocess,sys
mode=sys.argv[1]; recpath=pathlib.Path(sys.argv[2])
root=pathlib.Path("scripts/node_modules")
helpers=["conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper","conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-db-helper"]
def run(*a):
    try: return subprocess.run(list(a),capture_output=True,text=True)
    except (FileNotFoundError,TypeError): return subprocess.CompletedProcess(a,127,"","")
g=lambda *a: subprocess.check_output(["git",*a],text=True)
def manifest():
    rows=[]
    for d,dirs,files in os.walk(root):
        dirs.sort()
        for n in sorted(dirs+files):
            p=os.path.join(d,n); rel=os.path.relpath(p,root)
            if os.path.islink(p): rows.append("L "+os.readlink(p)+"  "+rel)
            elif os.path.isfile(p): rows.append("F "+hashlib.sha256(open(p,"rb").read()).hexdigest()+"  "+rel)
    return [hashlib.sha256("".join(x+"\n" for x in rows).encode()).hexdigest(),len(rows)]
def packages():
    lock=json.loads(pathlib.Path("scripts/package-lock.json").read_text())
    want={k[len("node_modules/"):]:v["version"] for k,v in lock["packages"].items() if k.startswith("node_modules/")}
    for name,version in want.items():
        pj=json.loads((root/name/"package.json").read_text())
        assert pj.get("name")==name and pj.get("version")==version, ("version",name)
    top=set()
    for e in os.listdir(root):
        if e.startswith("@"): top|={e+"/"+x for x in os.listdir(root/e)}
        elif e not in (".package-lock.json",".bin"): top.add(e)
    assert top==set(want), ("packages",sorted(top^set(want)))
    nested=[d for d,_,_ in os.walk(root) if os.path.basename(d)=="node_modules" and pathlib.Path(d)!=root]
    assert not nested, ("nested node_modules",nested)
    return dict(sorted(want.items()))
def tools():
    t={"node":run("node","-p","process.versions.node").stdout.strip(),"npm":run("npm","--version").stdout.strip(),"git":run("git","--version").stdout.strip(),"python3":sys.version.split()[0],"NODE_PATH":os.environ.get("NODE_PATH"),"NODE_OPTIONS":os.environ.get("NODE_OPTIONS")}
    m=re.fullmatch(r"(\d+)\.(\d+)\.(\d+)",t["node"])
    t["nodeOk"]=bool(m) and int(m[1])==22 and int(m[2])>=13
    t["nodeSqlite"]=run("node","-e","process.stdout.write(typeof require(\"node:sqlite\").DatabaseSync)").stdout
    t["sqlite3Cli"]=shutil.which("sqlite3")
    t["sqlite3CliVersion"]=run(t["sqlite3Cli"],"--version").stdout.strip() if t["sqlite3Cli"] else None
    sh=shutil.which("sh"); t["sh"]=os.path.realpath(sh) if sh else None
    return t
def native():
    out={}
    for h in helpers:
        r=run("node","-e","try{process.stdout.write(require.resolve(\"sqlite3\",{paths:[process.argv[1]]}))}catch(e){if(e.code!==\"MODULE_NOT_FOUND\")throw e;process.stdout.write(\"MODULE_NOT_FOUND\")}",os.path.abspath(h))
        assert r.returncode==0, r.stderr
        out[h]=r.stdout
    return out
assert g("status","--porcelain","--untracked-files=all")=="", "dirty worktree"
assert g("rev-parse","HEAD:scripts/package.json").strip()=="a23405cfa08022dc9f9a90babd6046cbd00b73ae", "scripts/package.json differs from B"
assert g("rev-parse","HEAD:scripts/package-lock.json").strip()=="eecf8e6d8a415225f0f3eb39d8e762d1f7a84269", "scripts/package-lock.json differs from B"
if mode=="record":
    assert not recpath.exists(), "setup record exists"
    t=tools(); rec={"tools":t,"holds":[]}; code=0
    if not t["nodeOk"] or t["nodeSqlite"]!="function":
        code=8; rec["holds"].append("Node 22.13 or later in the 22 line with node:sqlite: RED 10 and 14; GREEN 30, 34, 35, 42 to 49, 54, 57 and 60")
    if not t["sqlite3Cli"]:
        code=code or 7; rec["holds"].append("sqlite3 CLI: GREEN 35 (verify-sync-flow.js:685-708, called from 3541; test-sync-history-schema.js:53-57)")
    if not t["sh"] or os.path.basename(t["sh"])!="bash":
        code=code or 10; rec["holds"].append("sh must be bash: GREEN 52 (check-mqtt-topics.sh:4 pipefail, :6-10 array)")
    try:
        rec["scriptsPackages"]=packages(); rec["scriptsNodeModules"]=manifest()
    except Exception as e:
        code=code or 9; rec["holds"].append("scripts/node_modules from the pinned lock: RED 15 and GREEN 47 (replication.test.js:26-27): "+repr(e))
    try:
        rec["nativeSqlite3"]=native()
        rec["gate35NativeHeld"]=any(v!="MODULE_NOT_FOUND" for v in rec["nativeSqlite3"].values())
    except Exception as e:
        code=code or 8; rec["holds"].append("Node resolution probe failed: "+repr(e))
    rec["status"]="ok" if code==0 else "hold"
    recpath.write_text(json.dumps(rec,indent=2,sort_keys=True)+"\n")
    print(json.dumps(rec,sort_keys=True)); sys.exit(code)
rec=json.loads(recpath.read_text())
assert rec["status"]=="ok", "setup record is not ok"
t=tools()
for k in ("node","npm","nodeSqlite","sqlite3Cli","sqlite3CliVersion","sh","NODE_PATH","NODE_OPTIONS"):
    assert t[k]==rec["tools"][k], ("prerequisite changed since setup",k)
assert packages()==rec["scriptsPackages"], "scripts packages changed since setup"
assert manifest()==rec["scriptsNodeModules"], "scripts/node_modules changed since setup"
assert native()==rec["nativeSqlite3"], "native sqlite3 resolution changed since setup"
print("ISSUE233_DEPS_OK "+mode)
sys.exit(3 if mode=="green" and rec["gate35NativeHeld"] else 0)'
MKTMP='import os,stat,sys
t,w=sys.argv[1:3]
assert os.path.isabs(t) and os.path.normpath(t)==t, "TMPDIR must be a normalized absolute path"
assert not os.path.lexists(t), "TMPDIR exists: "+t
parent=os.path.dirname(t)
assert os.path.isdir(parent) and os.path.realpath(parent)==parent, "TMPDIR parent must be an existing directory without symbolic links"
wr=os.path.realpath(w)
assert t!=wr and not t.startswith(wr+os.sep), "TMPDIR is inside the execution worktree"
os.mkdir(t,0o700); os.chmod(t,0o700)
st=os.lstat(t)
assert stat.S_ISDIR(st.st_mode) and stat.S_IMODE(st.st_mode)==0o700 and st.st_uid==os.getuid(), "TMPDIR type, mode or owner"
print("ISSUE233_TMPDIR_CREATED "+t)'
~~~

`cap`, `need`, `red`, `gate`, `fresh`, `commitcheck`, `EDRUN`, `DEPS` and `MKTMP` keep their U definitions byte for byte except the base, packet, generation and prerequisite-consumer strings. `EDRUN` still checks the accepted editor digest, writes the bytes into a sealed `memfd` (`F_SEAL_SHRINK`, `F_SEAL_GROW`, `F_SEAL_WRITE`, `F_SEAL_SEAL`), reads them back, moves the descriptor to standard input and runs `exec node -`; Node never reads the extracted file. The editor's `blobOf` keeps its 8 MiB output limit: the largest object it reads is the B bcm2712 `flows.json` (1946613 bytes). A transport failure exits 11 and a digest mismatch 6 before Node runs; both are setup failures.

Plan commit (`STAGE=plan`), from a fresh isolated worktree whose HEAD is B. `ISSUE233_ACCEPTED_ASSET_SHA256`, `ISSUE233_ACCEPTED_HELPER_SHA256` and `ISSUE233_ACCEPTED_EDITOR_SHA256` come from the independent acceptance record for this packet: the SHA-256 of this file, of `plan-commit-allowlist.cjs`, and of the EDITOR block (its bytes from the line after the opening fence up to the closing fence, plus one final line feed). This plan cannot carry its own digest.

~~~sh
: "${ISSUE233_ACCEPTED_ASSET_SHA256:?accepted plan asset digest}" "${ISSUE233_ACCEPTED_HELPER_SHA256:?accepted helper digest}" "${ISSUE233_ACCEPTED_EDITOR_SHA256:?accepted editor digest}"
export ISSUE233_ACCEPTED_ASSET_SHA256 ISSUE233_ACCEPTED_HELPER_SHA256 ISSUE233_ACCEPTED_EDITOR_SHA256
fresh 00-fresh
need 00-start 60 python3 -I -c 'import os,subprocess,sys
g=lambda *a: subprocess.check_output(["git",*a],text=True)
assert os.path.realpath(g("rev-parse","--show-toplevel").strip())==os.path.realpath(sys.argv[1]), "not the execution worktree"
assert g("rev-parse","HEAD").strip()==sys.argv[2], "HEAD is not B"
assert g("status","--porcelain","--untracked-files=all")=="", "dirty worktree"
print("START_OK")' "$W" "$B"
need 00-copy-plan 60 python3 -I -c 'import hashlib,os,pathlib,re,sys
for k in ("ISSUE233_ACCEPTED_ASSET_SHA256","ISSUE233_ACCEPTED_HELPER_SHA256","ISSUE233_ACCEPTED_EDITOR_SHA256"):
    assert re.fullmatch(r"[0-9a-f]{64}",os.environ[k]), k
plan=pathlib.Path(sys.argv[1]).read_bytes(); helper=pathlib.Path(sys.argv[2]).read_bytes()
assert hashlib.sha256(plan).hexdigest()==os.environ["ISSUE233_ACCEPTED_ASSET_SHA256"], "plan asset differs from its accepted digest"
assert hashlib.sha256(helper).hexdigest()==os.environ["ISSUE233_ACCEPTED_HELPER_SHA256"], "helper differs from its accepted digest"
src=plan.decode()
mk="\n[[EDITOR]]\n~~~js\n"; assert src.count(mk)==1; b=src.index(mk)+len(mk); e=src.index("\n~~~\n",b)
assert hashlib.sha256((src[b:e]+"\n").encode()).hexdigest()==os.environ["ISSUE233_ACCEPTED_EDITOR_SHA256"], "editor block differs from its accepted digest"
dst=pathlib.Path("docs/superpowers/plans/issue-233-exact-plan.md")
assert not dst.exists(), "plan path exists"
dst.parent.mkdir(parents=True,exist_ok=True)
dst.write_bytes(plan)
assert dst.read_bytes()==plan
print("PLAN_COPIED")' "$A/issue-233-exact-plan.md" "$A/plan-commit-allowlist.cjs"
need 00-allowlist 60 node "$A/plan-commit-allowlist.cjs" "$W"
need 00-add-plan 60 git add -- docs/superpowers/plans/issue-233-exact-plan.md scripts/verify-doc-hygiene-allowlist.json
fresh 00-precommit
need 00-commit-plan 120 git $ID commit -m 'docs: pin issue 233 exact plan' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
commitcheck 00-plan-commit "$B" docs/superpowers/plans/issue-233-exact-plan.md scripts/verify-doc-hygiene-allowlist.json
~~~

Expected: `START_OK`, `PLAN_COPIED`, `plan-commit-allowlist: inserted 1 entry`, then `COMMIT_OK <sha>` for a commit whose sole parent is B and whose diff is exactly the two paths. An independent reviewer compares the committed plan with the accepted asset and records it as `ISSUE233_ADMITTED_PLAN_SHA`. `COMMIT_OK` alone is not admission.

Setup (`STAGE=setup`; HEAD = admitted plan SHA) is the U setup stage with the r7 names: fresh main check, private `TMPDIR`, start fences, private npm directories, `npm ci --ignore-scripts --prefix scripts` from the lock pinned at B (`scripts/package.json` blob `a23405cfa08022dc9f9a90babd6046cbd00b73ae`, `scripts/package-lock.json` blob `eecf8e6d8a415225f0f3eb39d8e762d1f7a84269`, the same blobs as at the U base), and `DEPS record`. The setup body is:

~~~sh
: "${ISSUE233_ADMITTED_PLAN_SHA:?reviewed plan commit SHA required}" "${T:?literal private TMPDIR path that does not exist yet}"
fresh s00-fresh
need s00-tmpdir 60 python3 -I -c "$MKTMP" "$T" "$W"
export TMPDIR="$T"
N="$TMPDIR/issue233-npm"
need s01-start 60 python3 -I -c 'import os,subprocess,sys
g=lambda *a: subprocess.check_output(["git",*a],text=True)
w,sha=sys.argv[1:3]
assert os.path.realpath(g("rev-parse","--show-toplevel").strip())==os.path.realpath(w), "not the execution worktree"
assert g("rev-parse","HEAD").strip()==sha, "HEAD is not the admitted plan commit"
assert g("status","--porcelain","--untracked-files=all")=="", "dirty worktree"
assert subprocess.run(["git","check-ignore","-q","scripts/node_modules"]).returncode==0, "scripts/node_modules is not ignored"
for p in sys.argv[3:]: assert not os.path.lexists(p), "exists: "+p
print("SETUP_START_OK")' "$W" "$ISSUE233_ADMITTED_PLAN_SHA" scripts/node_modules "$N" "$D"
need s02-npm-dirs 60 python3 -I -c 'import pathlib,sys
n=pathlib.Path(sys.argv[1]); n.mkdir(mode=0o700)
for d in ("cache","logs","home"): (n/d).mkdir(mode=0o700)
for f in ("userconfig","globalconfig"): (n/f).touch(mode=0o600,exist_ok=False)
print("NPM_DIRS_OK")' "$N"
need s03-npm-ci 900 env -i PATH="$PATH" HOME="$N/home" TMPDIR="$TMPDIR" NPM_CONFIG_USERCONFIG="$N/userconfig" NPM_CONFIG_GLOBALCONFIG="$N/globalconfig" npm_config_cache="$N/cache" npm_config_logs_dir="$N/logs" npm_config_registry=https://registry.npmjs.org/ npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false npm ci --ignore-scripts --prefix scripts
need s04-record 300 python3 -I -c "$DEPS" record "$D"
~~~

Stage 1 (`STAGE=tests`; HEAD = admitted plan SHA; the extractor reads the admitted Git blob, never the campaign file):

~~~sh
: "${ISSUE233_ADMITTED_PLAN_SHA:?reviewed plan commit SHA required}" "${ISSUE233_ACCEPTED_EDITOR_SHA256:?accepted editor digest}" "${T:?literal private TMPDIR path that does not exist yet}"
export ISSUE233_ADMITTED_PLAN_SHA ISSUE233_ACCEPTED_EDITOR_SHA256
fresh 01-fresh
need 01-tmpdir 60 python3 -I -c "$MKTMP" "$T" "$W"
export TMPDIR="$T"
need 01-deps 300 python3 -I -c "$DEPS" tests "$D"
need 01-extract-tests 120 python3 -I -c 'import hashlib,os,re,subprocess,pathlib
sha=os.environ["ISSUE233_ADMITTED_PLAN_SHA"]; want=os.environ["ISSUE233_ACCEPTED_EDITOR_SHA256"]
assert re.fullmatch(r"[0-9a-f]{40}",sha) and re.fullmatch(r"[0-9a-f]{64}",want)
assert subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()==sha
rel="docs/superpowers/plans/issue-233-exact-plan.md"
blob=subprocess.check_output(["git","cat-file","blob",sha+":"+rel])
assert pathlib.Path(rel).read_bytes()==blob
src=blob.decode()
mk="\n[[EDITOR]]\n~~~js\n"; assert src.count(mk)==1; b=src.index(mk)+len(mk); e=src.index("\n~~~\n",b)
ed=(src[b:e]+"\n").encode(); got=hashlib.sha256(ed).hexdigest()
assert got==want, "extracted editor differs from its accepted digest: "+got
out=pathlib.Path(os.environ["TMPDIR"],"issue233-phase-a-apply-tests.cjs")
with open(out,"xb") as f: f.write(ed)
os.chmod(out,0o600)
assert hashlib.sha256(out.read_bytes()).hexdigest()==want
print("ISSUE233_EDITOR_EXTRACTED "+got)'
need 02-editor-tests 120 env ISSUE233_STAGE=tests ISSUE233_ADMITTED_PLAN_SHA="$ISSUE233_ADMITTED_PLAN_SHA" python3 -I -c "$EDRUN" "$TMPDIR/issue233-phase-a-apply-tests.cjs"
need 03-add-tests 60 git add -- .github/workflows/migrations.yml conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.test.js scripts/osi-lib-binding-audit.js scripts/osi-lib-binding-audit.test.js scripts/test-conditional-irrigation-flow.js scripts/test-flows-wiring.js scripts/test-issue-233-weather-detach.js scripts/test-outbox-retry-backoff.js scripts/test-valve-command-safety-path.js scripts/verify-sync-flow.js
fresh 04-fresh
need 04-commit-tests 120 git $ID commit -m 'test: reproduce S2120 pair detach and cloud unclaim through the unclaim gate' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
commitcheck 05-test-commit "$ISSUE233_ADMITTED_PLAN_SHA" .github/workflows/migrations.yml conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.test.js scripts/osi-lib-binding-audit.js scripts/osi-lib-binding-audit.test.js scripts/test-conditional-irrigation-flow.js scripts/test-flows-wiring.js scripts/test-issue-233-weather-detach.js scripts/test-outbox-retry-backoff.js scripts/test-valve-command-safety-path.js scripts/verify-sync-flow.js
~~~

Expected: `ISSUE233_TMPDIR_CREATED <T>`, `ISSUE233_DEPS_OK tests`, `ISSUE233_EDITOR_EXTRACTED <digest>`, `ISSUE233_EDITOR_DIGEST_OK <digest>`, `ISSUE233_EDITOR_STDIN_SEALED <digest> 15855`, `ISSUE233_STAGE_TESTS_WRITTEN`, then `COMMIT_OK <sha>` for a commit whose sole parent is the admitted plan SHA and whose diff is exactly the 11 paths.

RED commands on the test commit, then the collector (section 12 names each expected reason):

~~~sh
red 10-red-focused 900 node --test scripts/test-issue-233-weather-detach.js
red 11-red-wiring 600 node scripts/test-flows-wiring.js
red 12-red-binding 300 node --test scripts/osi-lib-binding-audit.test.js
red 13-red-cond-flow 300 node --test scripts/test-conditional-irrigation-flow.js
red 14-red-backoff 300 node --test scripts/test-outbox-retry-backoff.js
red 15-red-replication 600 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.test.js
need 19-red-collect 120 python3 -I -c 'import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); ledger=pathlib.Path(sys.argv[2]).read_text().splitlines()
outer={p[1]:int(p[2]) for p in (l.split() for l in ledger) if len(p)==3 and p[0]=="RED"}
rows=[]
for label in sys.argv[3:]:
    row={"label":label,"wrapper_exit":outer.get(label)}
    status=root/label/"status.json"
    if not status.exists():
        row["class"]="inconclusive_not_run"; rows.append(row); continue
    st=json.loads(status.read_text())
    row.update(controller_exit=st["controller_exit"],direct_returncode=st["direct_returncode"],timed_out=st["timed_out"])
    if row["wrapper_exit"]!=st["controller_exit"]: row["class"]="inconclusive_exit_record"
    elif st["timed_out"] or st["controller_exit"] in (75,124,125): row["class"]="inconclusive_timeout_or_controller"
    elif st["controller_exit"]==0: row["class"]="unexpected_pass"
    else: row["class"]="nonzero_for_red_review"
    out=(root/label/"stdout").read_text(errors="replace")+(root/label/"stderr").read_text(errors="replace")
    row["failure_lines"]=[x for x in out.splitlines() if x.lstrip().startswith("not ok") or x.startswith("FAIL") or x.startswith("  - ")]
    rows.append(row)
pathlib.Path(str(root)+".red-summary.json").write_text(json.dumps(rows,indent=2)+"\n")
print(json.dumps([{k:v for k,v in r.items() if k!="failure_lines"} for r in rows]))
sys.exit(0 if all(r["class"]=="nonzero_for_red_review" for r in rows) else 4)' "$R" "$X" 10-red-focused 11-red-wiring 12-red-binding 13-red-cond-flow 14-red-backoff 15-red-replication
~~~

The collector sorts exits into classes and copies failure lines; it is the U collector with the label list changed. A zero exit, a timeout, an admission refusal (75), a controller error (125) or a wrapper exit that differs from the controller exit stops the stage as inconclusive. A `nonzero_for_red_review` row is RED evidence only after an independent reviewer matches its failure lines to section 12. Record `ISSUE233_ADMITTED_TEST_SHA` only after that review.

Stage 2 (`STAGE=product`; HEAD = the admitted test SHA; the editor re-checks the plan SHA, the parent chain and every Stage 1 byte):

~~~sh
: "${ISSUE233_ADMITTED_PLAN_SHA:?reviewed plan commit SHA required}" "${ISSUE233_ADMITTED_TEST_SHA:?accepted RED test commit SHA required}" "${ISSUE233_ACCEPTED_EDITOR_SHA256:?accepted editor digest}" "${T:?literal private TMPDIR path that does not exist yet}"
export ISSUE233_ADMITTED_PLAN_SHA ISSUE233_ADMITTED_TEST_SHA ISSUE233_ACCEPTED_EDITOR_SHA256
fresh 20-fresh
need 20-tmpdir 60 python3 -I -c "$MKTMP" "$T" "$W"
export TMPDIR="$T"
need 20-extract-product 120 python3 -I -c 'import hashlib,os,re,subprocess,pathlib
sha=os.environ["ISSUE233_ADMITTED_PLAN_SHA"]; tsha=os.environ["ISSUE233_ADMITTED_TEST_SHA"]; want=os.environ["ISSUE233_ACCEPTED_EDITOR_SHA256"]
assert re.fullmatch(r"[0-9a-f]{40}",sha) and re.fullmatch(r"[0-9a-f]{40}",tsha) and re.fullmatch(r"[0-9a-f]{64}",want)
assert subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()==tsha
rel="docs/superpowers/plans/issue-233-exact-plan.md"
blob=subprocess.check_output(["git","cat-file","blob",sha+":"+rel])
assert pathlib.Path(rel).read_bytes()==blob
src=blob.decode()
mk="\n[[EDITOR]]\n~~~js\n"; assert src.count(mk)==1; b=src.index(mk)+len(mk); e=src.index("\n~~~\n",b)
ed=(src[b:e]+"\n").encode(); got=hashlib.sha256(ed).hexdigest()
assert got==want, "extracted editor differs from its accepted digest: "+got
out=pathlib.Path(os.environ["TMPDIR"],"issue233-phase-a-apply-product.cjs")
with open(out,"xb") as f: f.write(ed)
os.chmod(out,0o600)
assert hashlib.sha256(out.read_bytes()).hexdigest()==want
print("ISSUE233_EDITOR_EXTRACTED "+got)'
need 21-editor-product 300 env ISSUE233_STAGE=product ISSUE233_ADMITTED_PLAN_SHA="$ISSUE233_ADMITTED_PLAN_SHA" ISSUE233_ADMITTED_TEST_SHA="$ISSUE233_ADMITTED_TEST_SHA" python3 -I -c "$EDRUN" "$TMPDIR/issue233-phase-a-apply-product.cjs"
need 22-add-product 60 git add -- conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/lifecycle.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/routes.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/lifecycle.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/routes.js
fresh 23-fresh
need 23-commit-product 120 git $ID commit -m 'fix: version S2120 pair detach and cloud unclaim through a thin unclaim gate' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
commitcheck 24-candidate-commit "$ISSUE233_ADMITTED_TEST_SHA" conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/lifecycle.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/routes.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/lifecycle.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/routes.js
~~~

Expected: `ISSUE233_TMPDIR_CREATED <T>`, `ISSUE233_EDITOR_EXTRACTED <digest>`, `ISSUE233_EDITOR_DIGEST_OK <digest>`, `ISSUE233_EDITOR_STDIN_SEALED <digest> 15855`, `ISSUE233_STAGE_PRODUCT_WRITTEN`, then `COMMIT_OK <sha>` for a commit whose sole parent is the test SHA and whose diff is exactly the 8 product paths.

GREEN gates on the product commit. `29-deps` runs first; a changed or missing prerequisite stops before any gate, and a resolvable native `sqlite3` holds gate 35 only. Every exit is recorded; any failure stops the candidate after the last gate.

~~~sh
cap 29-deps 300 python3 -I -c "$DEPS" green "$D"; dep=$?
case "$dep" in
  0) H35=0 ;;
  3) H35=1; printf 'HOLD 35-sync-flow native-sqlite3-resolves\n' >> "$X" || exit 1 ;;
  *) printf 'STOP 29-deps\n' >> "$X"; exit 1 ;;
esac
gate 30-focused 1200 node --test scripts/test-issue-233-weather-detach.js
gate 31-wiring 600 node scripts/test-flows-wiring.js
gate 32-binding 300 node --test scripts/osi-lib-binding-audit.test.js
gate 33-cond-flow 300 node --test scripts/test-conditional-irrigation-flow.js
gate 34-backoff 300 node --test scripts/test-outbox-retry-backoff.js
if [ "$H35" -eq 0 ]; then gate 35-sync-flow 1800 env OSI_FLOWS_SIZE_BASE_REF=$B OSI_DDL_BASE_REF=$B OSI_MIGRATIONS_BASE_REF=$B node scripts/verify-sync-flow.js; fi
gate 36-fn-parse 300 node scripts/verify-flows-fn-parse.js
gate 37-silent-catch 300 node scripts/verify-no-new-silent-catch.js
gate 38-parity 300 node scripts/verify-profile-parity.js
gate 39-contract 600 node scripts/verify-communication-contract.js
gate 40-size 300 node scripts/verify-flows-size-ratchet.js --base-ref $B
gate 41-inventory 300 node scripts/verify-test-inventory.js
gate 42-scoped-writes 900 node --test scripts/test-scoped-access-writes.js
gate 43-weather-source 300 node --test scripts/test-zone-weather-source.js
gate 44-scoped-verifier 1200 node scripts/verify-scoped-access.js
gate 45-scoped-verifier-test 1200 node --test scripts/verify-scoped-access.test.js
gate 46-lifecycle-routes 1200 node --test scripts/test-conditional-irrigation-lifecycle-routes.js scripts/test-conditional-irrigation-adapters.js scripts/test-conditional-irrigation-writer-guards.js
gate 47-policy-modules 1200 node scripts/run-module-tests.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/api.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/lifecycle.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/worker.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.test.js
gate 48-route-delegation 900 node --test scripts/test-delete-device-flow.js scripts/test-zone-device-assignment-flow.js
gate 49-outbox-builders 900 node --test scripts/test-journal-bootstrap.js scripts/test-outbox-event-flush.js
gate 50-bare-require 300 node scripts/flows-bare-require-scan.js
gate 51-stray-ddl 300 env OSI_DDL_BASE_REF=$B node scripts/verify-no-stray-ddl.js
gate 52-mqtt-topics 300 sh scripts/check-mqtt-topics.sh
gate 53-doc-hygiene 300 env -u OSI_DOC_HYGIENE_TERMS node scripts/verify-doc-hygiene.js
gate 54-weather-helper 300 node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-commands/weather.test.js
gate 55-generators 300 node --test scripts/migrate-flows-journal-generators.test.js
gate 56-helper-registration 300 node scripts/verify-helper-registration.js
gate 57-valve-safety 600 node --test scripts/test-valve-command-safety-path.js
gate 58-output-arity 300 node scripts/verify-flows-output-arity.js
gate 59-context-isolation 300 node scripts/verify-request-context-isolation.js
gate 60-no-conditional-helper 600 node --test scripts/test-sync-without-conditional-helper.js
gate 61-frozen-files 60 git diff --exit-code $B HEAD -- scripts/verify-flows-size-ratchet-allowances.json scripts/flows-growth-exceptions.json
fresh 69-fresh
if [ "${GATE_FAILED:-0}" -ne 0 ]; then printf 'STOP green\n' >> "$X"; exit 1; fi
if [ "$H35" -ne 0 ]; then printf 'HELD green 35-sync-flow\n' >> "$X"; exit 1; fi
~~~

Gates 56 to 61 are required by W's policy and by this design: helper registration (the gate's literal loader name), valve traversal through the gate (V2), output arity (gate outputs 2, adapter 3), request-context isolation, sync without the conditional helper (the two capture sites' `conditionalReplication &&` short circuit with the helper absent), and the frozen retired ledger and growth-exception file. A failing gate, an unexpected RED reason, a profile mismatch, any main drift from B seen by `fresh`, or an attempt to choose Phase B behavior stops execution for amendment and fresh review.

Paired server checks keep their separate admission, unchanged from the U plan's section 12.

## 14. Consumed inputs

The editor reads, at B or at the admitted plan commit: both `flows.json` copies, both copies of `lifecycle.js`, `routes.js`, `replication.js` and `replication.test.js` under `osi-irrigation-policy`, the seven Stage 1 base scripts and `.github/workflows/migrations.yml`, `scripts/verify-doc-hygiene-allowlist.json`, `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/flows-growth-exceptions.json` and this plan. Each blob at B:

| Path | Blob at B |
|---|---|
| `.github/workflows/migrations.yml` | `d967d94d86e9b5a807f34fafe75743dc3afe3b46` |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` | `9e981742777a6e53f13d56d86ae87c0b3e844788` |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/lifecycle.js` | `4fa5e8dfd95cc03e9c44f67a2d8953b6e9e45043` |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.js` | `3f32f0e2049eaae102ba1686a426cef8cf201da3` |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/replication.test.js` | `e3587b8ea3050fb8a1c7e62e5adc51def41b65c0` |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-irrigation-policy/routes.js` | `fa59ca5543e4854c1d32e566358b5f2d9786a240` |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | `9e981742777a6e53f13d56d86ae87c0b3e844788` |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/lifecycle.js` | `4fa5e8dfd95cc03e9c44f67a2d8953b6e9e45043` |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.js` | `3f32f0e2049eaae102ba1686a426cef8cf201da3` |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.test.js` | `e3587b8ea3050fb8a1c7e62e5adc51def41b65c0` |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/routes.js` | `fa59ca5543e4854c1d32e566358b5f2d9786a240` |
| `scripts/flows-growth-exceptions.json` | `a83fcefbd74486eeb86b407b424c666cb8157a00` |
| `scripts/osi-lib-binding-audit.js` | `e44deec4b922bb126bafbd364fc1080aba7d02ca` |
| `scripts/osi-lib-binding-audit.test.js` | `ac9a33ee14a77e72f90ec4550f6d7dcb8cf5ec4d` |
| `scripts/test-conditional-irrigation-flow.js` | `57cde94ed8b51a5f143d71c452f6dfacd928538e` |
| `scripts/test-flows-wiring.js` | `e75b039920cb07af3c85e0b3f683dfb63f7e1f63` |
| `scripts/test-outbox-retry-backoff.js` | `5f99dd3f73dfad7ce30ac3075bed0b9f7e9ca012` |
| `scripts/test-valve-command-safety-path.js` | `b744b843374bad93d72b158468b7439b0c0244b8` |
| `scripts/verify-doc-hygiene-allowlist.json` | `19bb92d3472aceef9971eecf21059d6006eb3b22` |
| `scripts/verify-flows-size-ratchet-allowances.json` | `c8714418f66f6ebe69fe045a479f3168fa024286` |
| `scripts/verify-sync-flow.js` | `7cbe4b055b5fb6b451e88bd167c269cfde656785` |

The RED and GREEN entry files above all exist at B (`git cat-file -e`, packet build). Static closure analysis from the U plan is evidence about its own base only; every command here is UNRUN at B.

## 15. Held items and coordination

**Deployment and rollback: HOLD, not claimed safe.** W's `deploy.sh` replaces the policy modules under `/srv/node-red` before it activates staged flows (`:2490-2548`), and its rollback restores the retained flows and GUI pair without restoring those modules (`:2975-3024`). HTTP readiness and schema compatibility do not establish command settlement. Every mixed pair below is unsupported:

| Flows | Policy modules | State | Outcome |
|---|---|---|---|
| B | Proposed `routes.js` and `lifecycle.js` | after module replacement and before activation, or after an automatic flow rollback | The envelope lacks the lease stamp, so the owner holds `lease_gateway_unavailable_or_mismatch` without ACK or application, on every poll. |
| B | Proposed `routes.js` and `lifecycle.js` | a bound decision was committed by the new version | B's generic replay path rejects the bound row (`protected_command_conflict`) before the owner can replay its ACK. |
| Proposed | B `replication.js`, loaded | outbox or force build | `conditionalReplication.flowPeerDb` is not a function and the builder throws; a loaded old module does not select the helper-absent path. |
| Proposed | B `routes.js` | any `UNCLAIM_DEVICE` | `routes.s2120UnclaimGate` is absent; the gate throws and sends nothing. |

A separately reviewed, source-bound solution covering forward partial replacement, automatic rollback and replay of decisions committed under the new protocol is required before any deployment admission. This plan changes no deploy script, adds no permission gate and weakens no lease, replay or protected-command rule. The campaign forbids deployment.

Also held: Phase B (scoped all-links local unclaim, deleted-zone handling, W10 and its checks); cloud `REMOVE_DEVICE_FROM_ZONE` for an S2120; the third-provider council vote (missing, never claimed); the server prerequisite; the maintainer risk-merge decision. Account unlink stays a preservation path. Follow-up, not in scope: five inline copies of the same peer database remain in `sync-bootstrap-build`, `sync-bootstrap-mark` and `sync-outbox-mark`.

Composition: both `flows.json` copies are shared with other open work; this plan changes `s2120-unclaim-gate` (new), `reject-indefinite-open` wires, `conditional-lifecycle-command-adapter` outputs and wires, and the bodies of `sync-outbox-build` and `sync-force-build` after their preflight spans. The editor refuses any drift. `osi-scope-helper` is unchanged.

## 16. Two-stage editor

[[EDITOR]]
~~~js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const edge = process.cwd();
const B = '0eaa6d87892708c66f5a004bf121656c5a52b17e';
const GATE = 's2120-unclaim-gate';
const planRel = 'docs/superpowers/plans/issue-233-exact-plan.md';
const hygieneRel = 'scripts/verify-doc-hygiene-allowlist.json';
const fixtureRel = 'scripts/test-issue-233-weather-detach.js';
const frozenRels = ['scripts/verify-flows-size-ratchet-allowances.json', 'scripts/flows-growth-exceptions.json'];
const stage = process.env.ISSUE233_STAGE;
if (!['tests', 'product'].includes(stage)) throw new Error('ISSUE233_STAGE must be tests or product');
const admitted = process.env.ISSUE233_ADMITTED_PLAN_SHA || '';
if (!/^[0-9a-f]{40}$/.test(admitted)) throw new Error('missing exact admitted plan commit SHA');
const gitEnv = Object.assign({}, process.env, { GIT_NO_LAZY_FETCH: '1' });
const git = (...args) => childProcess.execFileSync('git', args, { cwd: edge, encoding: 'utf8', env: gitEnv }).trim();
const blobOf = (rev, rel) => childProcess.execFileSync('git', ['cat-file', 'blob', git('rev-parse', rev + ':' + rel)], { cwd: edge, env: gitEnv, maxBuffer: 8 * 1024 * 1024 });
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const head = git('rev-parse', 'HEAD');
if (git('status', '--porcelain', '--untracked-files=all') !== '') throw new Error('stage requires a clean worktree');
const planParents = git('rev-list', '--parents', '-n', '1', admitted).split(' ');
if (planParents.length !== 2 || planParents[0] !== admitted || planParents[1] !== B) {
  throw new Error('plan commit is not a direct child of B');
}
const planDiff = git('diff', '--name-only', B, admitted).split('\n').filter(Boolean).sort();
if (JSON.stringify(planDiff) !== JSON.stringify([planRel, hygieneRel].sort())) throw new Error('plan commit inventory differs');
const committedPlan = blobOf(admitted, planRel);
if (!fs.readFileSync(path.join(edge, planRel)).equals(committedPlan)) throw new Error('working plan differs from the admitted plan blob');
const plan = committedPlan.toString('utf8');
const editorMarker = '\n[[EDITOR]]\n~~~js\n';
if (plan.split(editorMarker).length !== 2) throw new Error('editor marker missing or repeated');
const reviewedBlocks = plan.slice(0, plan.indexOf(editorMarker));
function fenced(marker) {
  const at = reviewedBlocks.indexOf(marker);
  if (at < 0 || reviewedBlocks.indexOf(marker, at + 1) >= 0) throw new Error('plan marker missing or repeated: ' + marker);
  const open = reviewedBlocks.indexOf('\n~~~', at);
  const lineEnd = reviewedBlocks.indexOf('\n', open + 1);
  if (open < 0 || lineEnd < 0 || !/^~~~[a-z]+$/.test(reviewedBlocks.slice(open + 1, lineEnd))) {
    throw new Error('plan code fence missing: ' + marker);
  }
  const close = reviewedBlocks.indexOf('\n~~~\n', lineEnd);
  if (close < 0) throw new Error('plan code fence unterminated: ' + marker);
  return reviewedBlocks.slice(lineEnd + 1, close);
}
function once(source, from, to) {
  if (source.split(from).length !== 2) throw new Error('edit anchor count != 1: ' + from.slice(0, 80));
  return source.replace(from, () => to);
}
const baseHygiene = JSON.parse(blobOf(B, hygieneRel).toString('utf8'));
const planHygiene = JSON.parse(blobOf(admitted, hygieneRel).toString('utf8'));
const addedHygiene = planHygiene.entries.filter((entry) =>
  !baseHygiene.entries.some((old) => JSON.stringify(old) === JSON.stringify(entry)));
if (planHygiene.entries.length !== baseHygiene.entries.length + 1 || addedHygiene.length !== 1 ||
    JSON.stringify(addedHygiene[0]) !== JSON.stringify(JSON.parse(fenced('[[PLAN-HYGIENE]]')))) {
  throw new Error('plan commit allowlist delta is not exactly the reviewed entry');
}
function assertFrozen(when) {
  for (const rel of frozenRels) {
    if (git('rev-parse', 'HEAD:' + rel) !== git('rev-parse', B + ':' + rel)) throw new Error(when + ': committed file differs from B: ' + rel);
    if (!fs.readFileSync(path.join(edge, rel)).equals(blobOf(B, rel))) throw new Error(when + ': working file differs from B: ' + rel);
  }
}
assertFrozen('before writing');
const admittedText = (rel) => blobOf(admitted, rel).toString('utf8');
const sameFile = (rel, expected) => fs.existsSync(path.join(edge, rel)) &&
  fs.readFileSync(path.join(edge, rel)).equals(Buffer.from(expected, 'utf8'));
const roots = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share'
];
const policyDir = 'node-red/osi-irrigation-policy/';
const ciAnchor = '      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-commands/weather.test.js';
const stage1 = new Map();
stage1.set(fixtureRel, fenced('[[FIXTURE]]') + '\n');
stage1.set('.github/workflows/migrations.yml',
  once(admittedText('.github/workflows/migrations.yml'), ciAnchor, ciAnchor + '\n' + fenced('[[CI-STEP]]')));
for (const [rel, hunks] of [
  ['scripts/test-flows-wiring.js', ['T1', 'T6a', 'T6b', 'T8', 'T9']],
  ['scripts/test-conditional-irrigation-flow.js', ['T2']],
  ['scripts/osi-lib-binding-audit.js', ['T3a', 'T3b']],
  ['scripts/osi-lib-binding-audit.test.js', ['T4a', 'T4b']],
  ['scripts/test-outbox-retry-backoff.js', ['T5']],
  ['scripts/verify-sync-flow.js', ['V1']],
  ['scripts/test-valve-command-safety-path.js', ['V2']]
]) {
  let text = admittedText(rel);
  for (const hunk of hunks) text = once(text, fenced('[[' + hunk + '-before]]'), fenced('[[' + hunk + '-after]]'));
  stage1.set(rel, text);
}
for (const root of roots) {
  const rel = root + '/' + policyDir + 'replication.test.js';
  const base = admittedText(rel);
  if (!base.endsWith('\n') || base.includes('flowPeerDb')) throw new Error('replication test base differs: ' + rel);
  stage1.set(rel, base + fenced('[[RT1]]') + '\n');
}
const stage1Paths = [...stage1.keys()].sort();
const gateFunc = fenced('[[GATE-FUNC]]');
const gatePin = /'s2120-unclaim-gate': Object\.freeze\(\{[^]*?funcSha256: '([0-9a-f]{64})'/.exec(fenced('[[T3b-after]]'));
if (!gatePin || gatePin[1] !== sha256(gateFunc)) throw new Error('gate source differs from its T3b pin');
if (stage === 'tests') {
  if (head !== admitted) throw new Error('test stage HEAD differs from the admitted plan SHA');
  if (fs.existsSync(path.join(edge, fixtureRel))) throw new Error('focused fixture already exists');
  for (const rel of stage1Paths) {
    if (rel !== fixtureRel && !sameFile(rel, admittedText(rel))) throw new Error('Stage 1 input differs from the admitted tree: ' + rel);
  }
  for (const [rel, text] of stage1) fs.writeFileSync(path.join(edge, rel), text);
  assertFrozen('after writing');
  process.stdout.write('ISSUE233_STAGE_TESTS_WRITTEN\n');
  process.exit(0);
}
const testSha = process.env.ISSUE233_ADMITTED_TEST_SHA || '';
if (!/^[0-9a-f]{40}$/.test(testSha) || head !== testSha) throw new Error('product stage HEAD differs from the exact test SHA');
const testParents = git('rev-list', '--parents', '-n', '1', testSha).split(' ');
if (testParents.length !== 2 || testParents[0] !== testSha || testParents[1] !== admitted) {
  throw new Error('test commit is not a direct child of the plan commit');
}
const testDiff = git('diff', '--name-only', admitted, testSha).split('\n').filter(Boolean).sort();
if (JSON.stringify(testDiff) !== JSON.stringify(stage1Paths)) throw new Error('test commit inventory differs from Stage 1');
for (const [rel, text] of stage1) if (!sameFile(rel, text)) throw new Error('Stage 1 bytes differ: ' + rel);
const profileFlows = roots.map((root) => {
  const file = path.join(edge, root, 'flows.json');
  const bytes = fs.readFileSync(file);
  if (!bytes.equals(blobOf(B, root + '/flows.json'))) throw new Error('flows differ from B: ' + file);
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(JSON.stringify(parsed, null, 2) + '\n'))) throw new Error('prewrite flows JSON roundtrip mismatch: ' + file);
  return { bytes, parsed };
});
if (!profileFlows[0].bytes.equals(profileFlows[1].bytes)) throw new Error('prewrite maintained flows profile mismatch');
const modules = {};
for (const name of ['lifecycle.js', 'routes.js', 'replication.js']) {
  const a = fs.readFileSync(path.join(edge, roots[0], policyDir + name));
  const b = fs.readFileSync(path.join(edge, roots[1], policyDir + name));
  if (!a.equals(b)) throw new Error('prewrite profile mismatch: ' + name);
  if (!a.equals(blobOf(B, roots[0] + '/' + policyDir + name))) throw new Error('policy file differs from B: ' + name);
  modules[name] = a.toString('utf8');
}
for (const hunk of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']) {
  modules['lifecycle.js'] = once(modules['lifecycle.js'], fenced('[[' + hunk + '-before]]'), fenced('[[' + hunk + '-after]]'));
}
for (const hunk of ['R1', 'R2', 'R3', 'R4', 'R5']) {
  modules['routes.js'] = once(modules['routes.js'], fenced('[[' + hunk + '-before]]'), fenced('[[' + hunk + '-after]]'));
}
modules['replication.js'] = once(modules['replication.js'], fenced('[[P1-before]]'), fenced('[[P1-after]]'));
const baseFlows = JSON.parse(profileFlows[0].bytes.toString('utf8'));
const flows = profileFlows[0].parsed;
function node(id) {
  const found = flows.filter((item) => item.id === id);
  if (found.length !== 1) throw new Error('node count: ' + id);
  return found[0];
}
const weather = node('weather-zones-command-apply-fn');
if (sha256(weather.func) !== 'f5984b17ac00a6535be5777b2fd85c5540959c64ca6e3c3c42f93f8b451f3531') throw new Error('weather node changed');
const mqttAck = weather.wires[1][0];
if (weather.wires[1].length !== 1 || node(mqttAck).type !== 'mqtt out') throw new Error('MQTT ACK node not found');
const adapter = node('conditional-lifecycle-command-adapter');
if (adapter.outputs !== 2 || adapter.wires.length !== 2 || adapter.wires[0].length !== 1 ||
    JSON.stringify(adapter.wires[1]) !== JSON.stringify(['command-ack-queue-rest'])) {
  throw new Error('adapter wiring differs from B');
}
adapter.outputs = 3;
adapter.wires = adapter.wires.concat([[mqttAck]]);
const guard = node('reject-indefinite-open');
if (JSON.stringify(guard.wires) !== JSON.stringify([['command-dedupe-dispatch'], ['command-ack-queue-rest']])) throw new Error('guard wiring differs from B');
guard.wires = [[GATE], ['command-ack-queue-rest']];
if (flows.some((item) => item.id === GATE)) throw new Error('gate id exists at B');
const dedupe = node('command-dedupe-dispatch');
const gate = {
  id: GATE, type: 'function', z: dedupe.z, name: 'S2120 Unclaim Owner Gate', func: gateFunc,
  outputs: 2, timeout: 0, noerr: 0, initialize: '', finalize: '',
  libs: [{ var: 'osiLib', module: 'osi-lib' }], x: dedupe.x, y: dedupe.y - 60,
  wires: [['command-dedupe-dispatch'], ['journal-command-apply-fn']]
};
if (JSON.stringify(Object.keys(gate)) !== JSON.stringify(Object.keys(dedupe))) throw new Error('gate key order differs from the dedupe node');
flows.splice(flows.indexOf(dedupe), 0, gate);
const outbox = node('sync-outbox-build');
const force = node('sync-force-build');
outbox.func = once(outbox.func, fenced('[[PEER-capture-before]]'), fenced('[[PEER-capture-after]]'));
force.func = once(force.func, fenced('[[PEER-capture-before]]'), fenced('[[PEER-capture-after]]'));
force.func = once(force.func, fenced('[[PEER-capability-before]]'), fenced('[[PEER-capability-after]]'));
force.func = once(force.func, fenced('[[PEER-invalidation-before]]'), fenced('[[PEER-invalidation-after]]'));
for (const builder of [outbox, force]) {
  if (builder.func.includes('const peerDb = {')) throw new Error('inline peer facade remains: ' + builder.id);
  builder.func = once(builder.func, 'ORDER BY occurred_at ASC LIMIT 100', 'ORDER BY occurred_at ASC, rowid ASC LIMIT 100');
}
const contract = JSON.parse(fenced('[[SIZE-CONTRACT]]'));
const isFunction = (item) => item && item.type === 'function' && typeof item.func === 'string';
const field = (item, key) => (typeof item[key] === 'string' ? item[key].length : 0);
const codeChars = (item) => item.func.length + field(item, 'initialize') + field(item, 'finalize');
const sizes = (list) => new Map(list.filter(isFunction).map((item) => [item.id, codeChars(item)]));
const before = sizes(baseFlows);
const after = sizes(flows);
const sum = (map) => [...map.values()].reduce((a, b) => a + b, 0);
for (const [id, size] of before) {
  if (!after.has(id)) throw new Error('function node removed: ' + id);
  if (after.get(id) > size) throw new Error('function node grew: ' + id);
}
const added = [...after.keys()].filter((id) => !before.has(id));
if (JSON.stringify(added) !== JSON.stringify([GATE])) throw new Error('new function nodes differ: ' + JSON.stringify(added));
if (before.size !== contract.baseFunctionNodes || after.size !== contract.functionNodes) throw new Error('function node count differs');
if (sum(before) !== contract.baseTotal || sum(after) !== contract.total || contract.total > contract.baseTotal) throw new Error('total differs from the contract');
const baseById = new Map(baseFlows.map((item) => [item.id, item]));
for (const [id, want] of Object.entries(contract.nodes)) {
  const item = node(id);
  const got = { chars: codeChars(item), func: item.func.length, initialize: field(item, 'initialize'), finalize: field(item, 'finalize'), funcSha256: sha256(item.func) };
  for (const key of Object.keys(got)) if (got[key] !== want[key]) throw new Error('size contract ' + id + ' ' + key + ': ' + got[key]);
  const base = baseById.get(id);
  if ((base ? codeChars(base) : null) !== want.base) throw new Error('size contract base ' + id);
}
if (codeChars(gate) > 1536 || !/osiLib\.require\s*\(/.test(gate.func)) throw new Error('gate is not a thin loader node');
const changedIds = new Set(['sync-outbox-build', 'sync-force-build', 'conditional-lifecycle-command-adapter', 'reject-indefinite-open']);
if (JSON.stringify(flows.filter((item) => item.id !== GATE).map((item) => item.id)) !== JSON.stringify(baseFlows.map((item) => item.id))) {
  throw new Error('node order differs from B');
}
for (const base of baseFlows) {
  const item = flows.find((candidate) => candidate.id === base.id);
  if (changedIds.has(base.id)) {
    const strip = (value) => JSON.stringify(Object.assign({}, value, { func: null, outputs: null, wires: null }));
    if (strip(item) !== strip(base)) throw new Error('node changed outside func, outputs and wires: ' + base.id);
    if (['conditional-lifecycle-command-adapter', 'reject-indefinite-open'].includes(base.id) && item.func !== base.func) {
      throw new Error('function changed: ' + base.id);
    }
  } else if (JSON.stringify(item) !== JSON.stringify(base)) {
    throw new Error('node changed: ' + base.id);
  }
}
function preflight(id, end) {
  const func = node(id).func;
  const start = func.indexOf('async function runGatewayMigrationPreflight');
  const stop = func.indexOf(end, start);
  if (start < 0 || stop <= start) throw new Error('preflight span missing: ' + id);
  return sha256(func.slice(start, stop));
}
for (const [id, want] of Object.entries(contract.preflight)) {
  if (preflight(id, want.end) !== want.sha256) throw new Error('preflight span changed: ' + id);
}
const rendered = JSON.stringify(flows, null, 2) + '\n';
if (sha256(rendered) !== contract.flowsSha256) throw new Error('rendered flows differ from the reviewed digest');
for (const [name, digest] of Object.entries(contract.modules)) {
  if (sha256(modules[name]) !== digest) throw new Error('module differs from the reviewed digest: ' + name);
}
for (const root of roots) {
  for (const name of Object.keys(modules)) fs.writeFileSync(path.join(edge, root, policyDir + name), modules[name]);
  fs.writeFileSync(path.join(edge, root, 'flows.json'), rendered);
}
assertFrozen('after writing');
process.stdout.write('ISSUE233_STAGE_PRODUCT_WRITTEN\n');
~~~
