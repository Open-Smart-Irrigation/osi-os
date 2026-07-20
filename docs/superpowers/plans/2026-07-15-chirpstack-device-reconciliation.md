# ChirpStack device reconciliation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make device registration prove that an existing ChirpStack device belongs to the requested application and profile, bound every gRPC call, and close every client after use.

**Architecture:** Extend the existing `osi-chirpstack-helper` rather than adding a second provisioning path. `ensureDeviceProvisioned` will compare the existing device with the requested name, application, profile, enabled state, and optional JoinEUI; it updates mismatches, rereads the device, and returns success only when the read-back matches. Cloud registration uses the sync stop-loss external-effect boundary: persist a token-independent `INTENT_PERSISTED` record before the first RPC, reconcile the idempotent/read-back effect after crashes, and commit local domain state, token-free ledger outcome, and token-bound outbox ACK together. Each gRPC request uses a fixed deadline, the helper exposes one idempotent `close()`, and both registration flows close their client in `finally`. Existing-device updates are restored if a later key or local-database step fails.

**Tech Stack:** Node.js 22 `node:test`, ChirpStack v4 protobuf/gRPC clients, Node-RED function nodes, `osi-chirpstack-helper`, SQLite.

## Global constraints

- Execute the sync stop-loss and writer recovery plans before live registration testing.
- Base implementation on `origin/main` containing merged [OSI OS PR #146](https://github.com/Open-Smart-Irrigation/osi-os/pull/146), merge commit `f50950b1767a1aa6302ef2553d68a4e379b5b142` or a verified descendant. Preserve bootstrap's identityd readiness check and `request-restart chirpstack_bootstrap 60`, the absence of direct bootstrap Node-RED restart, deploy-time identityd quiescence/restoration, and all merged lifecycle tests/allowances.
- Under `2026-07-15-refactor-repair-program.md`, use this plan's Kaba100 steps as checks inside the single Train A deployment, not as a separate deploy or restart.
- In that program mode, export `OSI_REPAIR_PROGRAM_MODE=1` and do not stage OSI OS `AGENTS.md` in a source-slice commit. Record the reviewed invariant fragment in the execution report; the program orchestrator owns the single integrated A1 documentation checkpoint.
- Do not edit ChirpStack SQLite directly during implementation. The helper remains the only runtime provisioning path.
- Do not hardcode application or profile UUIDs. Desired IDs come from the existing `CHIRPSTACK_APP_*` and `CHIRPSTACK_PROFILE_*` mappings.
- Do not log or place AppKeys, API keys, or `.chirpstack.env` contents in test output.
- Use a fixed 10,000 ms gRPC deadline; do not add another UCI flag for this repair.
- Preserve create rollback: if a newly created device cannot finish provisioning, delete it.
- Preserve existing-device state on a later failure: restore its prior name, application, profile, enabled state, description, and JoinEUI, then surface any rollback failure.
- Treat the supplied LoRaWAN 1.0.x AppKey as ChirpStack `nwkKey`. A create omits `appKey` and `genAppKey`; an update preserves those existing fields byte-for-byte and changes only `nwkKey`.
- Classify cloud registration as an idempotent external effect in the shared command ledger. Persist its protected command/effect identity and `INTENT_PERSISTED` state before ChirpStack mutation. A restart may reconcile or repeat only this read-back-idempotent operation; it may not infer completion from a local device row or emit an ACK without the ledger/outbox transaction.
- Reread after create, `ALREADY_EXISTS`, and update. A successful mutation call without matching read-back is failure.
- Edit both maintained flow profiles through one guarded JSON mutation and keep them byte-identical.
- The `scripts/verify-flows-size-ratchet-allowances.json` edits in this plan target the absolute `max_chars`/`max_total` schema created by repair-program Task A0. At the pinned base the file still holds base-relative deltas, so standalone execution outside the program must land A0's ratchet-format migration first (or an equivalent reviewed migration) before changing any ceiling.
- Do not access `osicloud.ch`. Live proof is local ChirpStack on Kaba100 only, after backup.

---

## Confirmed gap

`ensureDeviceProvisioned` currently reads the existing device but compares none of its assignment fields. When a device exists, the helper skips creation, reconciles only keys, and reports `deviceExisted:true`. A device assigned to a stale profile can therefore communicate in ChirpStack while the exact-profile UC512 ingress filter drops every uplink. Both registration flows report provisioning success.

The helper also calls unary gRPC methods without deadlines and exposes no client shutdown. Registration and queue-management flow nodes create clients per request. A stalled local ChirpStack can hold a Node-RED request indefinitely, and repeated calls can retain channels.

## File map

| File | Responsibility after this plan |
|---|---|
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js` | Device update/read-back reconciliation, fixed RPC deadlines, and client close lifecycle. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js` | Fake-client create, existing-device, race, rollback, deadline, and close tests. |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/*` | Byte-identical maintained-profile mirror. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | Registration clients closed in `finally`, with reconciliation result exposed to API/ACK callers. |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap` | Prefers the deployed `/srv/node-red` bootstrap so the tested source is the source executed on existing gateways. |
| `scripts/verify-sync-flow.js` | Pins read-back reconciliation, deadlines, close lifecycle, and both registration call sites. |
| `.github/workflows/verify-sync-flow.yml` | Runs the helper suite in CI. |
| `scripts/test-ci-guard-wiring.js` | Pins the direct helper and final stop-loss producer commands in the required workflow. |
| `docs/operations/chirpstack-device-reconciliation.md` | Operator-visible result fields and safe live verification procedure. |
| `AGENTS.md` | Registration success requires application/profile read-back equality. |

### Task 1: Pin the existing-device and lifecycle failures

**Files:**

- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.test.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify: `scripts/test-ci-guard-wiring.js`

**Interfaces:**

- Consumes: exported `ChirpStackClient` for prototype-based fakes that do not open network channels.
- Produces: `fakeDevice(fields)` with protobuf-compatible getters and setters.
- Produces: deterministic operation logs for get, create, update, keys, delete, rollback, and close.
- Produces: request-boundary tests using the real generated protobuf request/message classes with fake service clients.

- [ ] **Step 1: Add a fake protobuf device**

Use a plain object with the methods the helper reads and mutates:

```js
function fakeDevice(input = {}) {
  const state = {
    devEui: input.devEui || 'A8404101FD5ECF41',
    name: input.name || 'Dendro 3',
    applicationId: input.applicationId || 'app-old',
    deviceProfileId: input.deviceProfileId || 'profile-old',
    description: input.description || '',
    joinEui: input.joinEui || '',
    isDisabled: input.isDisabled === true,
  };
  return {
    state,
    getDevEui: () => state.devEui,
    getName: () => state.name,
    setName: (value) => { state.name = value; },
    getApplicationId: () => state.applicationId,
    setApplicationId: (value) => { state.applicationId = value; },
    getDeviceProfileId: () => state.deviceProfileId,
    setDeviceProfileId: (value) => { state.deviceProfileId = value; },
    getDescription: () => state.description,
    setDescription: (value) => { state.description = value; },
    getJoinEui: () => state.joinEui,
    setJoinEui: (value) => { state.joinEui = value; },
    getIsDisabled: () => state.isDisabled,
    setIsDisabled: (value) => { state.isDisabled = Boolean(value); },
  };
}
```

- [ ] **Step 2: Add behavior tests against an unconstructed client**

Prefix these test names with `[reconcile]`. Create `Object.create(ChirpStackClient.prototype)` and replace its RPC-facing methods with fakes. Cover:

- missing device: create, reread exact assignment, create keys, return `deviceAction:'created'`;
- exact existing device: no create/update, keys unchanged, return `deviceAction:'unchanged'`;
- wrong application: update once, reread exact assignment, return `deviceAction:'updated'`;
- wrong profile and disabled device: one update repairs both;
- name-only mismatch: update and report `updated`;
- `ALREADY_EXISTS` race: reread, reconcile, then keys;
- update call succeeds but reread remains wrong: reject at step `verifyDevice`;
- key mutation fails after an existing-device update: restore the original device fields;
- key mutation fails after a create: delete the new device;
- later failure after keys were created on an existing device: delete only the new key row and restore any device fields;
- later failure after keys were updated: restore the original keys without exposing them in result or error text;
- concurrent device reassignment after the verified write: compensation detects aggregate ownership loss, performs zero device or key mutations, and returns bounded `RECONCILIATION_REQUIRED`;
- concurrent change to each of `nwkKey`, `appKey`, and `genAppKey`: each case performs zero key or device mutations and returns the same bounded result;
- restore failure: reject with both the provisioning and rollback failures, never report provisioned.

- [ ] **Step 3: Pin deadlines and close behavior**

Prefix these test names with `[rpc]`. Export `grpcInvoke` for direct tests through the normal module export. Use a fake unary client that captures its arguments, asserts the call options contain a `Date` deadline, then invokes the callback with `{ code: grpc.status.DEADLINE_EXCEEDED, details: 'deadline exceeded' }`. Require the Promise to reject with only the allowlisted operation step and normalized gRPC status code; raw `details`, message, metadata, cause, and stack are never copied across the helper boundary. Do not use a fake that never calls back: a captured deadline option alone does not make a plain JavaScript fake enforce time.

Instantiate a client with five fake service clients and call `close()` twice. Every distinct underlying client must receive one close call. Make the first and third underlying close throw; require every remaining distinct client still closes, the returned bounded error list contains only the allowlisted service role and fixed `CLOSE_FAILED` code, and the second top-level call performs no close again.

Add `[rpc-shape]` tests that instantiate the real generated protobuf messages and replace only the service clients. Capture each invoked method, request, metadata, and call options for `updateDevice`, create/update/delete keys, device restoration, key restoration, and newly-created-device deletion. Assert the exact service method, generated request class, getter-visible DevEUI and owned fields, unchanged DevEUI during update, API-key metadata, and 10 s deadline. A new LoRaWAN 1.0.x key row contains `devEui` and supplied AppKey as `nwkKey` while omitting `appKey`/`genAppKey`. Updating an existing row changes only `nwkKey` and copies its previous `appKey`/`genAppKey` exactly into the full protobuf update request when present; read-back proves the two preserved values did not change. For restore calls, assert the original application/profile/name/description/JoinEUI/disabled values and the complete prior key tuple are encoded exactly. Use distinct sentinel values for all three key fields and require them to appear only inside captured request/read-back objects, never in a result, thrown error, warning, ACK, or formatted operation log.

- [ ] **Step 4: Add flow lifecycle red tests**

Prefix these test names with `[flow]`. Execute `CS Register Device` and `CS Register (cloud cmd)` with a fake helper client. Require `close()` after success, validation failure, reconciliation failure, and local DB failure. The current nodes fail these checks because neither client is closed.

- [ ] **Step 5: Run the new suite and capture the red signal**

```bash
node --test --test-name-pattern='^\[(rpc|rpc-shape)\]' \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
node scripts/verify-sync-flow.js
```

Expected on current `main`: missing `ChirpStackClient` export/update/read-back/close behavior and absent flow-client cleanup.

- [ ] **Step 6: Prepare CI wiring and preserve red evidence**

Add this command to the narrow-waist runtime step:

```yaml
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
```

Extend `scripts/test-ci-guard-wiring.js` with this exact command and a remove-one negative. Task 4 later adds the direct stop-loss command after producer-role rewiring and runs the completed guard.

Record the focused failures in the execution report or review notes. Keep the tests, verifier, and workflow edits uncommitted until Task 4 makes reconciliation and every client-owner case green. Do not push a deliberately failing CI commit.

### Task 2: Add bounded RPC and explicit client ownership

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.js`
- Test: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js`

**Interfaces:**

- Produces: `grpcInvoke(client, methodName, request, metadata, step)` with the shipped deadline fixed at 10,000 ms.
- Produces: `ChirpStackClient.close() -> Array<{ service: string, code: 'CLOSE_FAILED' }>`, idempotent, close-all, and data-free.

- [ ] **Step 1: Pass a deadline on every unary RPC**

```js
const DEFAULT_RPC_TIMEOUT_MS = 10000;

function grpcInvoke(client, methodName, request, metadata, step) {
  return new Promise((resolve, reject) => {
    client[methodName](
      request,
      metadata,
      { deadline: new Date(Date.now() + DEFAULT_RPC_TIMEOUT_MS) },
      (error, response) => error
        ? reject(toGrpcError(error, step || methodName))
        : resolve(response)
    );
  });
}
```

Do not accept a caller, environment, or configuration timeout override in the shipped factory. Every existing `grpcInvoke` call uses the same fixed deadline. Tests control time through an injected clock/fake timer at the module boundary rather than broadening the runtime API, and assert an extra sixth argument cannot change the deadline.

`toGrpcError` returns an unknown-field-rejecting bounded error carrying only `step` from the reviewed operation-step allowlist and `code` from the normalized gRPC status allowlist. Unknown steps become `grpc_call`; unknown codes become `UNKNOWN`. Never include the source exception's message, `details`, metadata, cause, stack, path, payload, or keys. Throw a unique secret sentinel from every primary RPC, rollback RPC, callback, outer flow catch, and close path; the sentinel must be absent from serialized errors, Node-RED warnings/errors, ACKs, and operation logs.

- [ ] **Step 2: Add idempotent close**

```js
close() {
  if (this.closed) return this.closeErrors || [];
  const closeErrors = [];
  for (const [service, client] of distinctNamedClients(this)) {
    try {
      if (client && typeof client.close === 'function') client.close();
    } catch (error) {
      closeErrors.push({ service, code: 'CLOSE_FAILED' });
    }
  }
  this.closeErrors = closeErrors;
  this.closed = true;
  return closeErrors;
}
```

Initialize `this.closed=false` and `this.closeErrors=[]` in the constructor. Deduplicate shared client objects while retaining the first stable service role. Never return or log the thrown exception text from `close`; the allowlisted service role and fixed code are the complete result. Do not close shared credentials separately. A throwing client must not prevent any later close. Add a thrown secret-sentinel error and prove it is absent from returned values, logs, and serialized reconciliation output.

- [ ] **Step 3: Export the tested interfaces and run tests**

Export `ChirpStackClient`, `grpcInvoke`, and `DEFAULT_RPC_TIMEOUT_MS` alongside the existing public factory functions. These exports support direct behavioral tests; runtime callers continue using `createClient` and `createProvisioningClientFromEnv`.

```bash
node --test --test-name-pattern='^\[rpc\]' \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
```

- [ ] **Step 4: Mirror and checkpoint bounded-RPC behavior**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.js
node scripts/verify-profile-parity.js
```

Do not commit yet; existing-device reconciliation and flow ownership tests remain red.

### Task 3: Reconcile and verify the existing device assignment

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.js`
- Test: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js`

**Interfaces:**

- Produces: `deviceSnapshot(device) -> { name, applicationId, deviceProfileId, description, joinEui, isDisabled }`.
- Produces: `deviceMatches(device, desired) -> boolean`.
- Produces: `updateDevice(device, desired) -> Promise<void>`.
- Produces: `deleteKeys(devEui) -> Promise<boolean>` for compensating a newly created key row on an existing device.
- Changes: `ensureDeviceProvisioned(...) -> { devEui, deviceAction, keysAction, keysVerified, verifiedApplicationId, verifiedDeviceProfileId }`, where successful reconciliation always returns the literal Boolean `keysVerified:true` after read-back equality.

- [ ] **Step 1: Add snapshot and equality helpers**

Normalize IDs by trimming only; ChirpStack UUID comparison is case-sensitive string equality. Normalize DevEUI and JoinEUI to uppercase.

```js
function deviceSnapshot(device) {
  return {
    name: String(device.getName() || '').trim(),
    applicationId: String(device.getApplicationId() || '').trim(),
    deviceProfileId: String(device.getDeviceProfileId() || '').trim(),
    description: String(device.getDescription() || ''),
    joinEui: normalizeHexKey(device.getJoinEui ? device.getJoinEui() : ''),
    isDisabled: Boolean(device.getIsDisabled()),
  };
}
```

The desired snapshot includes the supplied name/application/profile, `isDisabled:false`, the supplied description, and JoinEUI only when registration supplied one. An omitted JoinEUI does not erase an existing value.

- [ ] **Step 2: Add `updateDevice`**

Mutate the fetched protobuf object, place it in `UpdateDeviceRequest`, and call DeviceService `update` through `grpcInvoke(..., 'updateDevice')`. Build delete and restoration requests with their real generated request/message classes as well. Set only the fields owned by registration. Keep DevEUI unchanged. The `[rpc-shape]` tests from Task 1 are the acceptance boundary for these methods; behavior-only prototype fakes cannot satisfy this step.

- [ ] **Step 3: Rework ensure into create-or-reconcile plus read-back**

Use this operation order:

```text
get device
if missing: create
if create races with ALREADY_EXISTS: continue
reread device
snapshot original existing device
update when assignment differs
reread and require exact desired assignment
create or update keys
reread device again and require exact desired assignment
reread keys and require exact desired presence/value equality inside the helper
return verified IDs and actions
```

Before mutating keys on an existing device, snapshot `nwkKey`, `appKey`, and `genAppKey` inside the helper. Registration owns only `nwkKey`: create a missing row with the supplied AppKey in `nwkKey` and no `appKey`/`genAppKey`; when an existing `nwkKey` differs, send a full update containing the desired `nwkKey` plus the unchanged snapshot values for `appKey` and `genAppKey`. If `nwkKey` already matches, do not mutate any key field. After create/update reports success, call the real `getKeys` path and compare the desired `nwkKey` plus the preserved tuple with constant-time buffer/string equality inside the helper; expose only `keysVerified:true`, never values. A missing/stale reread or changed unowned key rejects at `verifyKeys` and enters normal compensation. Add behavior and real protobuf request-shape cases where create/update reports success but the reread is missing, stale, or has a changed preserved field.

Compensation is an all-or-nothing ownership fence across the changed provisioning aggregate, not per-resource replay. Retain exact pre-write and verified post-write snapshots for the device and key row. Before any compensating mutation, reread every resource this operation changed and require structural/constant-time equality with every post-write snapshot. Only when the complete aggregate still matches may compensation delete created resources or restore the prior device plus all three key fields. If any changed resource is missing or differs, perform zero compensating mutations anywhere, preserve the concurrent aggregate, and return bounded `RECONCILIATION_REQUIRED` naming only the fixed resource kind/step/code. After an authorized compensation, reread and verify the entire aggregate. Add barrier-controlled interleavings for device assignment and each of `nwkKey`, `appKey`, `genAppKey`, including cross-resource cases where only device or only keys changed, plus created-resource replacement races; every ownership-loss case asserts mutation count zero for both services. Never expose key material. A restoration failure carries only bounded step/code.

- [ ] **Step 4: Make return values truthful**

Replace the ambiguous `deviceExisted: !deviceCreated` result with:

```js
{
  devEui,
  deviceAction: 'created' | 'updated' | 'unchanged',
  keysAction: 'created' | 'updated' | 'unchanged',
  keysVerified: true,
  verifiedApplicationId: verified.applicationId,
  verifiedDeviceProfileId: verified.deviceProfileId,
}
```

Do not include key material. Update callers and tests that inspect `deviceCreated` to use `deviceAction === 'created'`.

- [ ] **Step 5: Run and checkpoint reconciliation**

```bash
node --test --test-name-pattern='^\[(rpc|rpc-shape|reconcile)\]' \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
node scripts/verify-profile-parity.js
```

Do not commit yet; Task 4 adds the local-persistence compensation and closes every shipped client owner before creating the green vertical slice.

### Task 4: Close clients and expose reconciliation outcomes in both flows

**Files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/chirpstack-bootstrap.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap`
- Modify: `deploy.sh`
- Modify/Test: `scripts/test-deploy-sh.sh`
- Modify/Test: `scripts/test-deploy-atomic-payload-wiring.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/verify-communication-contract.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify: `scripts/test-ci-guard-wiring.js`
- Modify/Test: `scripts/test-sync-delivery-fail-closed.js`

**Interfaces:**

- Consumes: truthful reconciliation result and idempotent client close from Tasks 2–3.
- Consumes from sync stop-loss Task 3: `persistExternalIntent`, `queueExternalIntentRetry`, `completeIdempotentExternalEffect`, and `db.durableTransaction`.
- Changes: `ensureDeviceProvisioned(registration, { afterProvisioned? })`, rolling back device/key effects when the callback rejects.
- Produces: local registration response/evidence facts `deviceAction`, `keysAction`, `keysVerified:true`, `verifiedApplicationId`, and `verifiedDeviceProfileId`; cloud command ACKs remain the exact canonical nine-field, server-lease-token-bound contract.
- Separates: local HTTP registration commits only its local device row; cloud registration commits local device row, token-free terminal ledger outcome, and token-bound ACK outbox through one shared transaction, then emits at most one data-free wake.

- [ ] **Step 1: Add red flow lifecycle assertions**

Require both registration nodes to declare `let client = null` outside `try`, create one client, and call `client.close()` in `finally`. Forbid creation of a second cleanup client. Require local DB closure in the same `finally` path. Execute `Cancel STREGA Actuation` with a fake client and require close after success, missing expectation, queue-flush failure, and DB failure. Execute the bootstrap entrypoint with a fake client and require close after success and provisioning failure.

In each flow-owner test, make the first helper close throw internally and make database close reject once. Require the helper to attempt every underlying client, require database close to run regardless, and require both bounded cleanup failures to reach `node.warn`/the error counter without key sentinels. Cleanup ordering cannot rely on a non-throwing fake.

- [ ] **Step 2: Update local registration**

Keep the client visible to error handling and avoid `return` inside `try`/`catch`, so cleanup facts can be attached without replacing the primary result:

```js
let client = null;
let provisioned = null;
let output = null;
let primaryError = null;
try {
  client = chirpstack.createProvisioningClientFromEnv(env);
  provisioned = await client.ensureDeviceProvisioned(registration, {
    afterProvisioned: (proof) => db.transaction(async (tx) => {
      await applyParameterizedDeviceMutation(tx, deviceMutation);
      await assertPersistedDevice(tx, deviceMutation, proof);
    })
  });
  flow.set('device_chirpstack_result', provisioned);
  output = [msg, null];
} catch (error) {
  // The helper owns provisioning rollback. Do not create another client here.
  primaryError = error;
  output = [null, registrationError(msg, error)];
} finally {
  let closeErrors = [];
  let databaseCloseError = null;
  try {
    if (client) closeErrors = client.close();
  } catch (error) {
    closeErrors = [{ service: 'client', code: 'CLOSE_FAILED' }];
  }
  try {
    await close();
  } catch (error) {
    databaseCloseError = 'database close failed';
  }
  for (const closeError of closeErrors) {
    node.warn('ChirpStack client close failed: ' + closeError.service);
  }
  if (databaseCloseError) node.warn(databaseCloseError);
  attachBoundedCleanupFacts(output, primaryError, closeErrors, databaseCloseError);
}
return output;
```

Define `registrationError`, `applyParameterizedDeviceMutation`, `assertPersistedDevice`, and `attachBoundedCleanupFacts` in the function node before the `try`. The first returns the existing second-output envelope with `success:false`, a fixed `error:'ChirpStack registration failed'`, an allowlisted `step`, and an allowlisted numeric/string gRPC code; it never copies raw error details, metadata, registration keys, or the request. The mutation accepts a fixed descriptor and bound parameters, never mutable `msg.topic` SQL. The reread compares the exact local DevEUI/type/application/profile facts with the verified helper proof before commit. The cleanup helper preserves the existing primary success/failure output, adds only cleanup service names/fixed codes/counts to a failure envelope, and records cleanup-only failures through fixed `node.warn` text/the existing error counter without throwing from `finally`. Add secret-sentinel tests for the inner and outer close catches, plus exact tests for validation, deadline, reconciliation, callback, rollback, unknown errors, primary failure plus both cleanup failures, and primary success plus cleanup failures. Assert this local HTTP path creates no `applied_commands` row, ACK outbox row, or transport wake. A process death before its local commit returns no success and makes no local row; repeating the same authorized request must reread the already-created/updated ChirpStack aggregate and commit once without a second semantic mutation. It does not claim automatic recovery without the operator's secret-bearing retry. Do not place the local database write after `ensureDeviceProvisioned` returns and do not delete an existing or newly created device from the flow. The callback keeps the database write inside the helper-owned compensation boundary; `ensureDeviceProvisioned` owns rollback before returning or throwing.

- [ ] **Step 3: Update cloud registration**

Use the same one-client/finally ownership.

Classify registration input and gateway configuration separately before invoking ChirpStack. Unsupported `type_id`, malformed DevEUI, and malformed or missing AppKey are command-owned permanent failures and map to `NACKED/REJECTED_PERMANENT` with `chirpstack_registration_invalid`. A supported type whose required `CHIRPSTACK_APP_*` or `CHIRPSTACK_PROFILE_*` mapping is absent or invalid is gateway or operator misconfiguration and maps to `FAILED_RETRYABLE/FAILED_RETRYABLE` with `chirpstack_mapping_unavailable`; it must not permanently reject the cloud command. Pin one table covering every supported type and required mapping, plus unsupported, malformed, missing-map, deadline, and reconciliation cases. Warnings, ACKs, and evidence expose only the fixed reason and mapping role, never environment values, AppKey, raw request, or exception text.

Before the first provisioning RPC, persist the external intent through the shared durable boundary. The cloud path is:

```js
const intent = await osiCommandLedger.persistExternalIntent(
  db,
  msg._commandLedgerContext,
  {
    effectClass: 'IDEMPOTENT_EXTERNAL',
    effectKind: 'CHIRPSTACK_DEVICE_RECONCILIATION',
    effectKey,
    desiredStateHash,
  }
);

const provisioned = await client.ensureDeviceProvisioned(registration, {
  afterProvisioned: (proof) =>
    osiCommandLedger.completeIdempotentExternalEffect(db, {
      context: msg._commandLedgerContext,
      intent,
      outcome: {
        status: 'ACKED',
        result: 'APPLIED',
        detail: 'chirpstack_reconciled',
        reason: null,
        appliedAt,
        appliedSyncVersion,
      },
      applyLocal: async (tx) => {
        await applyParameterizedDeviceMutation(tx, deviceMutation);
        await assertPersistedDevice(tx, deviceMutation, proof);
      },
    }),
});

msg._commandAckWake = true;
```

`persistExternalIntent` uses the stop-loss `durableTransaction`, so the power-loss-stable intent exists before the first RPC. `completeIdempotentExternalEffect` alone opens the completion transaction. It verifies the exact `INTENT_PERSISTED` provenance, applies and rereads the local row with bound parameters, writes the token-free terminal outcome, builds the nine-field ACK from the current protected token, supersedes older pending token generations, inserts the outbox row, and commits. The callback returns only its bounded commit receipt. There is no nested transaction, mutable raw SQL, or ACK construction after return.

Keep the five bounded reconciliation fields in the trusted local registration result, local HTTP response, and evidence only. Verified success requires `keysVerified === true` and uses `ACKED/APPLIED`, fixed detail `chirpstack_reconciled`, `duplicate:false`, and `reason:null` inside the atomic completion call. Command-owned invalid input is completed through the shared SQLite-only ledger/outbox transaction as `NACKED/REJECTED_PERMANENT` with `chirpstack_registration_invalid`; it never creates external intent. Missing supported-type mapping and pre-effect validation retry use the shared nonterminal retry path. Deadline, gRPC, read-back, same-process callback, or guarded compensation failure calls `queueExternalIntentRetry` as `FAILED_RETRYABLE/FAILED_RETRYABLE` with fixed reason `chirpstack_reconciliation_failed`, retaining the intent for fresh-token reconciliation. Same-token retry returns exact stored bytes. A fresh protected token rereads/converges the desired ChirpStack state and then completes; it does not treat `INTENT_PERSISTED` as a terminal replay.

Repurpose `cs-reg-cloud-ack-fn` as a wake-only gate after the callback commit. It may emit only `{_commandAckWake:true}` to the REST outbox scanner, with no ACK, token, command ID, row ID, helper fields, or delivery claim. Wakes coalesce behind an in-flight flush and the scheduled 30 s scan recovers a crash before wake. Remove the `command-ack-queue-rest` insertion path and every MQTT command-completion edge from this branch. A post-return queue transaction, helper-result spread, or local response shortcut fails the stop-loss producer reachability fixture. The final producer inventory names the cloud callback completion in `cs-reg-cloud-fn`; `cs-reg-cloud-ack-fn` is not an ACK producer.

Inside the helper, invoke `afterProvisioned(result)` only after device/key read-back verification and make it the final fallible helper action. Before the callback commits, rejection runs the aggregate-wide ownership fence: one mismatch means zero compensation; a complete match permits the full inverse and reread from the in-memory prior snapshot. After the callback commits, no later helper error or cleanup failure may compensate. After process death, never claim the ledger contains prior keys; reread and converge the protected desired state or enter reconciliation-required. Add callback-rejection tests after create/update/key-create/unchanged plus cross-resource interleavings for device and each key field. The unchanged and ownership-loss cases perform no compensating mutation; no output contains key sentinels.

The cloud node records the bounded commit receipt before entering cleanup. A client/database close warning after commit cannot enter the provisioning catch, queue a retryable ACK, change the committed domain outcome, or suppress the wake; it increments only the existing cleanup error counter. Tests combine a committed callback with each cleanup failure and require one stored success ACK plus one wake and zero compensation/retry rows.

Inject process death before/after intent commit; after each device/key RPC and verified read-back; after local mutation, ledger completion, and ACK insert; after commit before callback return; after helper return before wake; and after wake before HTTP response. Precommit SQLite faults roll back local mutation, ledger completion, and ACK together while retaining the intent. Postcommit faults retain all three and never compensate. Add compensation failure/mismatch and local-HTTP zero-ledger/outbox/wake controls. Execute the production queue dispatch, intent API, helper, completion transaction, wake-only branch, and REST scanner together and write the deterministic edge-owned producer bytes. The later cross-repository server test vendors those bytes and posts them through the real OSI Server controller; OSI OS CI never loads a sibling server branch. Across the two-leg proof, require accepted terminal success/permanent results and accepted nonterminal/terminal retry behavior without key leakage.

Modify the stop-loss producer inventory in this same Task 4 slice: `cs-reg-cloud-fn` is the atomic completion producer and `cs-reg-cloud-ack-fn` is wake-only. Add remove-one and role-swap negatives. Run and stage `scripts/test-sync-delivery-fail-closed.js`; a stale expectation from the earlier sync commit cannot remain green after this rewiring.

- [ ] **Step 4: Close queue-management clients and execute the tested bootstrap**

Hoist the STREGA cancel client outside its `try`, close it in the existing `finally` alongside the database, and do not close before the transaction finishes. In `scripts/chirpstack-bootstrap.js`, wrap every operation after `createClient` in `try/finally` and close exactly once. Mirror the canonical bootstrap script byte-for-byte to both profile overlays.

The merged service still prefers the ROM path, so deploying only `/srv/node-red/chirpstack-bootstrap.js` does not activate this fix. In both maintained services, prefer the deployed verified `/srv/node-red/chirpstack-bootstrap.js` and use ROM only when that path is absent, while preserving the merged identityd readiness check and coordinated `request-restart chirpstack_bootstrap 60`; never restore a direct Node-RED restart. Extend `deploy.sh` only inside its existing identityd quiescence/EXIT-restoration fence. Add ROM-first/stale-helper, direct-restart, selected-service ordering, identityd-not-quiescent, tamper, crash, restore, and coordinated-restart preservation controls. Train B later replaces this compatibility preference with verified `payloads/current` selection.

Add a verifier that discovers every `createClient` and `createProvisioningClientFromEnv` call in maintained flows and bootstrap source and fails if its owning async boundary lacks a reachable `finally` close. This is a bounded ownership check over the shipped call sites, not a substring count. Include an in-memory negative control that removes the STREGA close and bootstrap `finally` independently.

- [ ] **Step 5: Execute helper, flow, and lifecycle tests**

Before running the ratchet, use `scripts/flows-size-scan.js` against the fixed integrated Task 4 base and final canonical flow. Replace only the absolute `max_chars` ceilings for `cs-register-device-fn`, `cs-reg-cloud-fn`, `cs-reg-cloud-ack-fn`, and `cancel-strega-actuation-fn`, and set absolute `max_total` to the exact measured final total, with bounded reconciliation/cleanup reasons. Do not round up. Extend `scripts/verify-sync-flow.js` with owned-node/reason and extra-character failure controls; the general ratchet owns the numeric ceilings.

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-profile-parity.js
node scripts/verify-communication-contract.js
node scripts/test-sync-delivery-fail-closed.js
node scripts/test-ci-guard-wiring.js
node --test scripts/backup-chirpstack-sqlite.test.js
/bin/sh scripts/test-deploy-sh.sh --mode train-a-compat
node --test scripts/test-deploy-atomic-payload-wiring.js
sh scripts/test-gateway-identity-helper.sh
sh scripts/test-osi-identityd.sh
sh scripts/test-identityd-service-lifecycle.sh
node scripts/verify-live-gateway-identity.js
node --test scripts/test-deploy-migration-wiring.js
node scripts/test-journal-bootstrap.js
sh -n conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap
sh -n deploy.sh
```

- [ ] **Step 6: Mirror and commit**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
cp scripts/chirpstack-bootstrap.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js
cp scripts/chirpstack-bootstrap.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  scripts/chirpstack-bootstrap.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap \
  deploy.sh \
  scripts/verify-sync-flow.js scripts/test-flows-wiring.js \
  scripts/verify-communication-contract.js scripts/test-sync-delivery-fail-closed.js \
  scripts/test-ci-guard-wiring.js \
  scripts/test-deploy-sh.sh scripts/test-deploy-atomic-payload-wiring.js \
  scripts/verify-flows-size-ratchet-allowances.json \
  .github/workflows/verify-sync-flow.yml
git commit -m "fix: reconcile ChirpStack devices and close clients"
```

### Task 5: Run release gates and verify one controlled reconciliation

**Files:**

- Create: `docs/operations/chirpstack-device-reconciliation.md`
- Modify: `AGENTS.md`
- Runtime evidence through the existing pipeline collector.

**Interfaces:**

- Consumes: Tasks 1 through 4 and the completed writer recovery.
- Produces: one backed-up, read-before/write/read-after Kaba100 reconciliation with fresh database ingest.

When invoked by `2026-07-15-refactor-repair-program.md`, this task consumes the single Train A Task A4 backup/deployment receipt and shared verification boundary on the merged identity baseline. It must not take a second backup, deploy another payload, or restart any of the four guarded roles; only the operator-approved ChirpStack reconciliation and read-back evidence are new live actions. The standalone backup wording below applies only when this plan is explicitly authorized outside the program.

- [ ] **Step 1: Document the operator result contract**

Document `deviceAction`, `keysAction`, `keysVerified:true`, the two verified IDs, the 10 s deadline, and the rule that registration success requires read-back equality. State that AppKeys and API keys must not appear in evidence.

- [ ] **Step 2: Run local gates**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-helper-registration.js
node scripts/verify-command-safety.js
node scripts/verify-communication-contract.js
node scripts/verify-profile-parity.js
sh scripts/test-gateway-identity-helper.sh
sh scripts/test-osi-identityd.sh
sh scripts/test-identityd-service-lifecycle.sh
node scripts/verify-live-gateway-identity.js
node --test scripts/test-deploy-migration-wiring.js
node scripts/test-journal-bootstrap.js
scripts/check-mqtt-topics.sh
node .claude/skills/anti-slop-writing/slop-check.js \
  docs/operations/chirpstack-device-reconciliation.md AGENTS.md
git diff --check
```

- [ ] **Step 3: Commit the reviewed operator contract**

```bash
git add docs/operations/chirpstack-device-reconciliation.md
if [ "${OSI_REPAIR_PROGRAM_MODE:-0}" != "1" ]; then
  git add AGENTS.md
fi
git commit -m "docs: record ChirpStack reconciliation contract"
```

Keep device-specific live IDs/timestamps out of this contract commit; record them only in the execution evidence after the backed-up rehearsal.

- [ ] **Step 4: Back up Kaba100 and inspect without mutation**

At execution time, load `osi-live-ops-runbook`. In standalone mode, back up `/data/db`, `/srv/node-red`, and the GUI, then use the same staged `backup-chirpstack-sqlite.js` contract as repair A4: verify generated runtime config names regular nonsymlink `/srv/chirpstack/chirpstack.sqlite`; capture source device/inode, `PRAGMA schema_version`, and the `chirpstack` procd enabled/running/instance identity; run SQLite online `.backup` with `.timeout 5000` under a separate 30-second child watchdog; require unchanged source/service/schema identities, matching backup schema version, destination `PRAGMA quick_check = ok`, fsync, size, and SHA256; and bind every fact plus method `sqlite3-online-backup` into the manifest. Do not stop/restart ChirpStack. Runtime-path drift, service restart, source replacement, schema change/concurrent DDL, wall timeout, snapshot/check/fsync failure, or ambiguous service state fails before mutation. Under the repair program, reverify and consume A4's already-fsynced manifest instead. Read the selected test device's current application/profile/name and record only non-secret IDs.

- [ ] **Step 5: Reconcile one operator-approved device**

Use a device whose desired mapping is already known from Kaba100's UCI/profile contract. Run registration once and require `deviceAction` to match the pre-state. Reread through gRPC and ChirpStack SQLite, then wait one normal uplink cadence and require the same DevEUI to advance in `device_data`.

Do not deliberately misassign a live device to prove repair. The wrong-profile cases are covered by fake-client tests; live evidence proves the read-back and ingest path without creating an outage.

- [ ] **Step 6: Verify timeout behavior without blocking Node-RED**

Against a controlled unavailable local endpoint in a test invocation, require failure within 10–12 seconds, a bounded gRPC status in the response/ACK, client closure, and no local device row mutation.

## Exit criteria

This plan is complete only when:

- existing application/profile/name/disabled drift is updated or surfaced as a failed reconciliation;
- create, race, and update paths reread and compare the device before success;
- later failures restore existing state or delete a newly created device only while the aggregate ownership fence still matches the in-memory prior snapshot; concurrent ownership drift performs zero compensation and returns `RECONCILIATION_REQUIRED`;
- real protobuf request-shape tests cover update, delete, and restore RPC boundaries;
- every gRPC call has a 10 s deadline and every caller closes the client;
- both registration flows expose truthful non-secret reconciliation results;
- helper behavior and flow ownership run in CI; and
- one backed-up Kaba100 registration proves read-back equality followed by fresh edge persistence.
