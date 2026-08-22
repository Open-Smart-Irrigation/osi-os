# STREGA Gen2 (SV2) Device Profile and Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give STREGA Gen2 (SV2) valves a ChirpStack device profile carrying the Gen2 decoder, selected at registration, with automatic profile reconciliation for valves registered under the wrong generation.

**Architecture:** Gen2 is not a new device type — one `STREGA_VALVE` type serves both generations, so the frozen `sync-init-fn` boot node and the `devices.type_id` CHECK are never touched. All profile assignment funnels through one seam, `osi-chirpstack-helper`'s `ensureDeviceProvisioned`, which both registration paths already call; teaching that one function to reconcile an existing device's profile covers first registration, re-registration, and the cloud command path at once. The decoded-field mismatch between the two vendor codecs is fixed **before** the Gen2 profile is provisioned, so shipping the profile can never regress valve state.

**Tech Stack:** Node-RED flows.json function nodes, `osi-chirpstack-helper` (ChirpStack 4.12.1 gRPC bindings), `chirpstack-bootstrap.js`, BusyBox ash (`deploy.sh`), React 18 + TypeScript + Vite, SQLite (`valve_settings`).

**Spec:** [docs/superpowers/specs/2026-08-19-valve-control-design.md](../specs/2026-08-19-valve-control-design.md) §5 (generation handling) and §10 (hardware gates).

**Review history:** v1 of this plan was reviewed on 2026-08-21 and returned REWORK with 5 blockers (`scratchpad/gen2-plan-review.md`). This is v2. The corrections are load-bearing and are called out inline as **[v1 defect]** so the executor does not reintroduce them.

## Global Constraints

- **No new device type.** `devices.type_id` keeps its existing 7 values. An eighth forces the frozen boot-node `DEVICES_NEW_DDL` rebuild and its four-verifier merge gate (osi-os#173 trap class).
- **No schema migration.** `valve_settings.strega_generation TEXT NOT NULL DEFAULT 'GEN1' CHECK (strega_generation IN ('GEN1','GEN2'))` already exists (migration 0022).
- **`strega_model` (`STANDARD`/`MOTORIZED`, on `devices`) is a different axis from `strega_generation` (`GEN1`/`GEN2`, on `valve_settings`).** Never merge the two, never reuse one's endpoint for the other.
- **`chirpstack-bootstrap.js` has THREE byte-identical copies** — `scripts/chirpstack-bootstrap.js` (the one `deploy.sh` ships, `deploy.sh:618-619`) plus both `conf/full_raspberrypi_bcm27xx_bcm{2712,2709}/files/usr/share/node-red/` overlays. Parity is enforced by `verify-sync-flow.js`. **[v1 defect: v1 named only the two overlays, which would have turned a gate red and shipped nothing.]**
- **`flows.json` has two byte-identical copies**, edited only by one-shot Node scripts with the roundtrip guard (`osi-flows-json-editing` skill).
- **Never modify `conf/.../etc/init.d/osi-bootstrap`'s stamp validation.** It prefers the ROM script at `/usr/share/node-red/chirpstack-bootstrap.js`, which `deploy.sh` never updates, so a stricter stamp on a deployed-not-reflashed Pi never validates: bootstrap would re-run every boot, minting a fresh ChirpStack API key and rewriting `.chirpstack.env` each time. **[v1 defect: v1 did exactly this.]**
- **Every gate is judged by exit code** (`node script; echo $?`), never the last printed line.
- **No `npm run build`** (the workstation OOMs). Use `npm run typecheck` and `npm run test:unit`.
- **No STREGA valve exists on any gateway.** Nothing here is hardware-verifiable; validation is unit tests plus scratch harnesses. Do not claim hardware verification.
- **Commit, do not push.**

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `flows.json` node `strega-process-fn` | Accept Gen2 decoder field names so valve state survives the profile switch | 1 |
| `osi-chirpstack-helper/index.js` | `setDeviceProfile` primitive + profile reconciliation inside `ensureDeviceProvisioned` | 2 |
| `codecs/strega_gen2_decoder.js` (new, 2 overlays) | Vendor Gen2 decoder | 3 |
| `chirpstack-bootstrap.js` (3 copies) | Provision `OSI STREGA Valve Gen2`, emit `CHIRPSTACK_PROFILE_STREGA_GEN2` | 3 |
| `deploy.sh` | Fetch the codec; conditionally re-run bootstrap when the new env key is absent | 3 |
| `flows.json` nodes `post-devices-insert`, `cs-reg-cloud-fn`, `cs-register-device-fn` | Generation → profile selection on both registration paths; seed `valve_settings` | 4 |
| `web/react-gui/` modal, types, locales | Ask for the generation when registering a STREGA valve | 5 |
| `flows.json` node `valve-ack-fn` | Reconcile the ChirpStack profile from stored state after an ACK | 6 |
| docs + skills | Second profile, the two axes, bench gates | 6 |

---

### Task 1: Make STREGA uplink processing generation-agnostic

**Why first:** the Gen1 decoder emits `Valve`; the Gen2 decoder computes the same value but emits it as **`Actuator`**, and omits `Tamper`, `Leakage`, `Temperature`, `Hygrometry` entirely (it does emit `Cable` — verified during Task 1) (verified: `docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up` lines 168, 194, 218, 239). `strega-process-fn` reads `decodedObject.Valve`. Provisioning the Gen2 profile before this fix would make valve open/closed state decode as `null` on every Gen2 uplink — the feature would be net-negative. **[v1 defect: v1 had no such task.]**

**Files:**
- Modify: `flows.json` node `strega-process-fn`, both profiles
- Modify: `scripts/test-flows-wiring.js`

**Interfaces:**
- Produces: `strega-process-fn` treats `decodedObject.Actuator` as an alias for `decodedObject.Valve`. Task 3 depends on this being merged first.

- [ ] **Step 1: Read the node and the two vendor decoders**

```bash
cd /home/phil/Repos/osi-os
node -e "
const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
console.log(f.find(x=>x.id==='strega-process-fn').func);
"
grep -n "Actuator\|Valve" docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up
```

Record every `decodedObject.<Field>` the node reads and which decoder supplies it. Fields Gen2 omits must resolve to `null`, never to a fabricated default — the repo's missing-data rule.

- [ ] **Step 2: Write the failing wiring assertion**

Append to `scripts/test-flows-wiring.js`, matching the file's real helper names and per-profile loop style (read an existing section first — **there is no `FLOWS_PATHS`/`ok()`/`fail()` trio; use what the file actually defines** — **[v1 defect]**):

```js
// STREGA Gen2 decoder field alias: Gen2 emits `Actuator` where Gen1 emits `Valve`.
const stregaProcess = flows.find((n) => n.id === 'strega-process-fn');
assert(/Actuator/.test(stregaProcess.func),
  'strega-process-fn must accept the Gen2 decoder alias `Actuator` for `Valve`');
```

- [ ] **Step 3: Run it and watch it fail**

```bash
node scripts/test-flows-wiring.js >/dev/null 2>&1; echo "exit=$?"
```
Expected: `exit=1`, naming the new assertion.

- [ ] **Step 4: Add the alias**

Via a one-shot script, at the point the node first reads the valve field:

```js
const valveRaw = (decodedObject && decodedObject.Valve !== undefined && decodedObject.Valve !== null)
  ? decodedObject.Valve
  : (decodedObject ? decodedObject.Actuator : undefined);
```

Then use `valveRaw` wherever the node used `decodedObject.Valve`. Preserve the existing null/undefined handling exactly — this task changes *where the value comes from*, never how a missing value is treated.

- [ ] **Step 5: Prove it with a scratch harness**

Extract the node's `func`, stub `node`/`msg`, and feed three payloads: a Gen1-shaped object (`{Valve: 1, Tamper: 0, ...}`), a Gen2-shaped object (`{Actuator: 1, Battery: 95}` with no `Valve`, no `Tamper`), and `{}`. Assert the first two yield the same valve state and the third yields nulls without throwing. Include the output in the report.

- [ ] **Step 6: Verify and commit**

```bash
cmp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json; echo "cmp exit=$?"
for s in scripts/test-flows-wiring.js scripts/verify-no-new-silent-catch.js scripts/verify-flows-fn-parse.js \
         scripts/verify-profile-parity.js scripts/verify-flows-size-ratchet.js scripts/verify-sync-flow.js; do
  node "$s" >/dev/null 2>&1; echo "$s exit=$?"; done
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-flows-wiring.js
git commit -m "fix(strega): accept the Gen2 decoder's Actuator field as the valve state"
```

---

### Task 2: One seam for profile assignment

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js` (+ bcm2709 mirror, `cmp`-identical)
- Test: the helper module's own test file (locate with `ls` in the module dir; if none exists, follow the harness used by `osi-lib`'s loader tests)

**Interfaces:**
- Produces: `client.setDeviceProfile(devEui, deviceProfileId) → Promise<boolean>` (`true` when it swapped, `false` when already correct or the device is absent).
- Produces: `ensureDeviceProvisioned` now returns `{ devEui, deviceCreated, deviceExisted, keysAction, profileAction }` where `profileAction` is `'unchanged' | 'repointed'`. Tasks 4 and 6 consume both.

Existing shape, verified at `osi-chirpstack-helper/index.js:269-336`: `ensureDeviceProvisioned({devEui, appKey, applicationId, deviceProfileId, name, joinEui, description})` creates the device when absent and reconciles keys, but **never touches an existing device's profile** — so registering an already-known valve with a different generation is silently a no-op today. Both registration paths (`cs-register-device-fn`, `cs-reg-cloud-fn`) call it, which is why this is the right seam.

- [ ] **Step 1: Write the failing helper tests**

```js
test('setDeviceProfile swaps only the profile and preserves the rest of the device', async () => {
  const captured = {};
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', name: 'Vanne 1', applicationId: 'app-1', deviceProfileId: 'prof-gen1', description: 'zone 3' } });
  assert.equal(await client.setDeviceProfile('00DEC0DE00000001', 'prof-gen2'), true);
  assert.equal(captured.update.device.deviceProfileId, 'prof-gen2');
  assert.equal(captured.update.device.name, 'Vanne 1');
  assert.equal(captured.update.device.description, 'zone 3');
});

test('setDeviceProfile is a no-op when the profile already matches', async () => {
  const captured = {};
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', deviceProfileId: 'prof-gen2' } });
  assert.equal(await client.setDeviceProfile('00DEC0DE00000001', 'prof-gen2'), false);
  assert.equal(captured.update, undefined);
});

test('setDeviceProfile returns false for an unknown device', async () => {
  const client = stubClient({}, { device: null });
  assert.equal(await client.setDeviceProfile('00DEC0DE00000009', 'prof-gen2'), false);
});

test('ensureDeviceProvisioned re-points an existing device whose profile differs', async () => {
  const captured = {};
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', deviceProfileId: 'prof-gen1' }, keys: { nwkKey: 'A'.repeat(32) } });
  const result = await client.ensureDeviceProvisioned({ devEui: '00DEC0DE00000001', appKey: 'A'.repeat(32), applicationId: 'app-1', deviceProfileId: 'prof-gen2', name: 'Vanne 1' });
  assert.equal(result.profileAction, 'repointed');
  assert.equal(captured.update.device.deviceProfileId, 'prof-gen2');
});

test('ensureDeviceProvisioned reports unchanged when the profile already matches', async () => {
  const captured = {};
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', deviceProfileId: 'prof-gen2' }, keys: { nwkKey: 'A'.repeat(32) } });
  const result = await client.ensureDeviceProvisioned({ devEui: '00DEC0DE00000001', appKey: 'A'.repeat(32), applicationId: 'app-1', deviceProfileId: 'prof-gen2', name: 'Vanne 1' });
  assert.equal(result.profileAction, 'unchanged');
  assert.equal(captured.update, undefined);
});
```

Build `stubClient` in the module's established stubbing style — read the existing tests first and reuse their double, do not invent a second mocking approach.

- [ ] **Step 2: Run and watch them fail**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper && node --test .; echo "exit=$?"
```
Expected: `exit=1`, `client.setDeviceProfile is not a function`.

- [ ] **Step 3: Implement `setDeviceProfile`**

After `deleteDevice` (line ~255). The read-modify-write is required because ChirpStack's `update` replaces the whole device; `getDevice()` returns the live protobuf message, so mutating and resending it preserves tags, variables, joinEui, isDisabled and description. (The v1 reviewer verified `UpdateDeviceRequest`, `getDeviceProfileId()` and `setDeviceProfileId()` all exist in the vendored 4.12.1 bindings.)

```js
  async setDeviceProfile(devEui, deviceProfileId) {
    const targetId = String(deviceProfileId || '').trim();
    if (!targetId) throw annotateError(new Error('setDeviceProfile: deviceProfileId is required'), 'validate');
    const existing = await this.getDevice(devEui);
    if (!existing) return false;
    if (String(existing.getDeviceProfileId() || '') === targetId) return false;
    existing.setDeviceProfileId(targetId);
    const request = new devicePb.UpdateDeviceRequest();
    request.setDevice(existing);
    await grpcInvoke(this.deviceClient, 'update', request, this.metadata, 'setDeviceProfile');
    return true;
  }
```

- [ ] **Step 4: Reconcile the profile inside `ensureDeviceProvisioned`**

Inside the `try`, in the `if (!existingDevice)` else-path — i.e. only when the device already existed — and before the key reconciliation:

```js
    let profileAction = 'unchanged';
```
(declare beside `let keysAction = 'unchanged';` at line ~291)

```js
      } else if (String(existingDevice.getDeviceProfileId() || '') !== deviceProfileId) {
        await this.setDeviceProfile(devEui, deviceProfileId);
        profileAction = 'repointed';
      }
```

Add `profileAction` to the returned object. Do **not** re-point inside the rollback path, and do not extend the `deviceCreated` rollback to undo a re-point: a profile swap is not destructive and leaving it applied is safer than bouncing a device between profiles on an unrelated key failure. Note that choice in the report.

- [ ] **Step 5: Run the tests, mirror, verify**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper && node --test .; echo "exit=$?"
cd /home/phil/Repos/osi-os
cp -a conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.js
diff -rq conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper \
         conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper && echo "mirror identical"
node scripts/verify-helper-registration.js >/dev/null 2>&1; echo "helper-registration exit=$?"
```

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper
git commit -m "feat(chirpstack): reconcile a device's profile in ensureDeviceProvisioned"
```

---

### Task 3: Ship the Gen2 codec and provision the profile

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm{2712,2709}/files/usr/share/node-red/codecs/strega_gen2_decoder.js`
- Modify: **all three** `chirpstack-bootstrap.js` copies
- Modify: `deploy.sh`

**Interfaces:**
- Produces: env `CHIRPSTACK_PROFILE_STREGA_GEN2` in `/srv/node-red/.chirpstack.env`; ChirpStack profile `OSI STREGA Valve Gen2`. Tasks 4 and 6 read it.

- [ ] **Step 1: Install the decoder into both overlays**

```bash
cd /home/phil/Repos/osi-os
SRC="docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up"
D2712="conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen2_decoder.js"
sed 's/\r$//' "$SRC" > "$D2712"
cp "$D2712" "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/strega_gen2_decoder.js"
node --check "$D2712"; echo "syntax exit=$?"
grep -c "decodeUplink" "$D2712"
```
Expected: syntax exit=0 and at least one `decodeUplink`. If `decodeUplink` is absent, STOP and report — do not hand-write a wrapper.

- [ ] **Step 2: Extend all three bootstrap copies**

Edit `scripts/chirpstack-bootstrap.js` (the authoritative one `deploy.sh` ships), then copy it over both overlays and `cmp` all three. In `CFG` (near line 88):

```js
  profileStregaGen2Name: process.env.CS_PROFILE_STREGA_GEN2_NAME || 'OSI STREGA Valve Gen2',
  stregaGen2CodecPath: process.env.STREGA_GEN2_CODEC_PATH || '/srv/node-red/codecs/strega_gen2_decoder.js',
```

In the `[ 4/5 ] Device profiles` block, after the existing `stregaProfileId` line:

```js
  const stregaGen2CodecScript = readCodecScript(CFG.stregaGen2CodecPath, 'STREGA Gen2');
  const stregaGen2ProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileStregaGen2Name, 'Strega SV2 smart irrigation valve, Gen2 scheduler (LoRaWAN 1.0.3 OTAA)', stregaGen2CodecScript);
```

In `envVars`, after `CHIRPSTACK_PROFILE_STREGA`: `CHIRPSTACK_PROFILE_STREGA_GEN2: stregaGen2ProfileId,`. Add the summary `console.log` line, the two header-comment lines beside `CS_PROFILE_STREGA_NAME`/`STREGA_CODEC_PATH`, and bump the "7 device profiles" count to 8.

**Before writing:** read `getOrCreateProfileWithCodec` and record in your report whether it updates an existing profile's codec or only creates a missing one. If it only creates, say so plainly — it means a pre-existing Gen1 profile never receives a corrected codec, which is a finding for the operator, not something to fix here.

- [ ] **Step 3: Fetch the codec in deploy.sh**

`fetch_required` takes **three** arguments — label, source path, destination (`deploy.sh:618-619` is the pattern to copy) **[v1 defect: v1 showed two]**. After the `strega_gen1_decoder.js` block:

```sh
fetch_required "strega_gen2_decoder.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen2_decoder.js" \
    "/srv/node-red/codecs/strega_gen2_decoder.js"
```
Read lines 615-645 first and match the real call shape and indentation.

- [ ] **Step 4: Provision on already-deployed gateways, safely**

**Do not touch the init script.** Instead add a conditional deploy-time step to `deploy.sh`, after the codec fetches and after `chirpstack-bootstrap.js` is in place, that runs the freshly-deployed bootstrap **only** when the Gen2 key is missing:

```sh
if [ -f /srv/node-red/.chirpstack.env ] && \
   ! grep -q 'CHIRPSTACK_PROFILE_STREGA_GEN2=' /srv/node-red/.chirpstack.env 2>/dev/null; then
  echo "--- Provisioning STREGA Gen2 device profile (one-time) ---"
  if node /srv/node-red/chirpstack-bootstrap.js; then
    echo "OK: Gen2 profile provisioned"
  else
    echo "WARN: Gen2 profile provisioning failed; valves will register on the Gen1 profile"
  fi
fi
```

Three properties matter and must be stated in the report: it runs at most once per gateway; it runs the **fresh** `/srv/node-red/` copy rather than the stale ROM copy; and a failure warns without failing the deploy. Confirm from the bootstrap source whether the re-run mints a **new ChirpStack API key** — if it does, note in the report that this leaves exactly one extra key per gateway, which is the accepted cost of the one-shot.

- [ ] **Step 5: Verify**

```bash
cd /home/phil/Repos/osi-os
cmp scripts/chirpstack-bootstrap.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js; echo "copy2 exit=$?"
cmp scripts/chirpstack-bootstrap.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js; echo "copy3 exit=$?"
node --check scripts/chirpstack-bootstrap.js; echo "syntax exit=$?"
sh -n deploy.sh; echo "deploy.sh syntax exit=$?"
for s in scripts/verify-sync-flow.js scripts/verify-communication-contract.js scripts/verify-profile-parity.js; do
  node "$s" >/dev/null 2>&1; echo "$s exit=$?"; done
ls scripts/ | grep -i deploy    # run every deploy-wiring test the repo has; update any fetched-file inventory fixture
```
Expected: every exit=0.

- [ ] **Step 6: Commit**

```bash
git add scripts/chirpstack-bootstrap.js conf/full_raspberrypi_bcm27xx_bcm2712 conf/full_raspberrypi_bcm27xx_bcm2709 deploy.sh
git commit -m "feat(chirpstack): provision the STREGA Gen2 profile and ship its decoder"
```

---

### Task 4: Choose the profile by generation on both registration paths

**Files:**
- Modify: `flows.json` nodes `post-devices-insert`, `cs-reg-cloud-fn`, `cs-register-device-fn`, and the HTTP handler upstream of `post-devices-insert`, both profiles
- Modify: `scripts/test-flows-wiring.js`

**Verified node roles — v1 got this wrong** **[v1 defect]**: `post-devices-insert` has `libs: []`, does **no** database work, and builds a SQL string into `msg.topic`; it is where `profileMap` lives. `cs-register-device-fn` (`libs: osiDb + chirpstack`) is where the DB work and `ensureDeviceProvisioned` happen. `cs-reg-cloud-fn` is a **second, independent** registration path with its own `CHIRPSTACK_PROFILE_*` map — v1 missed it entirely.

**Interfaces:**
- Consumes: `CHIRPSTACK_PROFILE_STREGA_GEN2` (Task 3); `profileAction` from `ensureDeviceProvisioned` (Task 2).
- Consumes: request field `strega_generation` (`'GEN1'`|`'GEN2'`|absent) from Task 5.
- Produces: `valve_settings.strega_generation` seeded at registration.

- [ ] **Step 1: Read all four nodes end to end before editing**

```bash
node -e "
const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
for (const id of ['post-devices-insert','cs-register-device-fn','cs-reg-cloud-fn']) {
  const n=f.find(x=>x.id===id);
  console.log('=== '+id+' libs='+JSON.stringify(n.libs)+' ===');
  console.log(n.func);
}" | head -250
```
Identify the HTTP handler upstream of `post-devices-insert` (grep `new_device_appkey`) — that is where request validation belongs.

- [ ] **Step 2: Write the failing wiring assertions**

In the file's real style, per profile: `post-devices-insert` and `cs-reg-cloud-fn` both reference `CHIRPSTACK_PROFILE_STREGA_GEN2`; `cs-register-device-fn` references `valve_settings`.

- [ ] **Step 3: Run and watch them fail** — `node scripts/test-flows-wiring.js >/dev/null 2>&1; echo "exit=$?"` → `exit=1`.

- [ ] **Step 4: Validate the field in the HTTP handler**

```js
const gen = String(body.strega_generation || '').trim().toUpperCase();
if (gen && gen !== 'GEN1' && gen !== 'GEN2') {
  msg.statusCode = 400;
  msg.payload = { message: 'strega_generation must be GEN1 or GEN2' };
  return [null, msg];
}
flow.set('new_device_strega_generation', gen);
```
Set it the same way the handler already sets `new_device_appkey`; match that mechanism exactly rather than the snippet if they differ.

- [ ] **Step 5: Select the profile in both registration paths**

In `post-devices-insert`, after `profileMap` is built:

```js
const stregaGeneration = String(flow.get('new_device_strega_generation') || '').trim().toUpperCase();
if (type_id === 'STREGA_VALVE' && stregaGeneration === 'GEN2') {
  const gen2Profile = String(env.get('CHIRPSTACK_PROFILE_STREGA_GEN2') || '').trim();
  if (gen2Profile) profileMap.STREGA_VALVE = gen2Profile;
  else node.warn('[devices] CHIRPSTACK_PROFILE_STREGA_GEN2 unset; registering ' + deveui + ' on the Gen1 profile');
}
```

Apply the equivalent to `cs-reg-cloud-fn` against its own profile map, sourcing the generation from the cloud command payload (read the node to find the field it already parses; if the cloud payload carries no generation, default to Gen1 and say so in the report — do not invent a payload field).

Warn-and-continue is deliberate: a gateway whose bootstrap has not re-run must still register valves, and Task 6 repairs the profile later.

- [ ] **Step 6: Seed `valve_settings` in the node that owns the DB**

In `cs-register-device-fn` (which already holds an `osiDb` handle — reuse it; a second `new osiDb.Database` trips the wiring test's close audit), after successful provisioning, for STREGA devices only:

```js
await db.run(
  "INSERT INTO valve_settings (device_eui, strega_generation) VALUES (?, ?) " +
  "ON CONFLICT(device_eui) DO UPDATE SET strega_generation = excluded.strega_generation " +
  "WHERE valve_settings.strega_generation <> excluded.strega_generation AND excluded.strega_generation = 'GEN2'",
  [devEui, generation === 'GEN2' ? 'GEN2' : 'GEN1']
);
```

The `WHERE` clause is load-bearing: a plain upsert would **demote an already-promoted GEN2 valve back to GEN1** on any re-registration **[v1 defect]**. Only promotion is allowed to overwrite; a GEN1 re-registration of a known GEN2 valve leaves the stored value alone. Confirm the real primary-key column first:

```bash
grep -n "CREATE TABLE IF NOT EXISTS valve_settings" -A 14 database/seed-blank.sql
```

- [ ] **Step 7: Scratch-harness the DB behaviour**

Against a `node:sqlite` DB built from `database/seed-blank.sql`, assert: fresh GEN2 registration → `'GEN2'`; fresh GEN1 → `'GEN1'`; absent → `'GEN1'`; **re-registration as GEN1 of a valve already stored GEN2 → stays `'GEN2'`**; re-registration as GEN2 of a GEN1 valve → becomes `'GEN2'`. Include the output.

- [ ] **Step 8: Verify and commit**

Run the full flows verifier set from Task 1 Step 6 plus `verify-no-stray-ddl.js` and `flows-bare-require-scan.js`, all by exit code; re-measure any size-ratchet allowance in bytes against `origin/main`.

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-flows-wiring.js scripts/verify-flows-size-ratchet-allowances.json
git commit -m "feat(devices): select the STREGA profile by generation on both registration paths"
```

---

### Task 5: Ask for the generation in the add-device modal

**Files:**
- Modify: `web/react-gui/src/types/farming.ts:164-169`, `web/react-gui/src/components/farming/AddDeviceModal.tsx`
- Modify: `web/react-gui/public/locales/*/devices.json` — the German directory is **`de-CH`** and the modal's namespace is **`addModal`**, not `addDevice` **[v1 defect]**. Enumerate the real directories with `ls web/react-gui/public/locales/`.
- Test: the existing add-device test file (find it; **do not assume an `onAdd` prop or that labels carry `htmlFor`** — read the component and match its real props and query strategy **[v1 defect]**)

**Interfaces:**
- Produces: `AddDeviceRequest.strega_generation?: StregaGeneration` on `POST /api/devices` (consumed by Task 4).
- Consumes: the `StregaGeneration` union already exported from `types/farming.ts` and used by `ValveSettingsDialog`. Reuse it; declare no second union.

- [ ] **Step 1: Read the component and its existing test**, then write failing tests asserting: the generation control appears only for `STREGA_VALVE`; submitting a STREGA valve includes `strega_generation`; submitting a non-STREGA device omits the field entirely. Use the component's real submit prop and the query strategy its existing tests use (`getByRole`/`getByLabelText` only if the markup supports it — otherwise add the missing `htmlFor`/`id` pair as part of this task and say so).

- [ ] **Step 2: Run them and watch them fail** — `cd web/react-gui && npx vitest run <the test file> --silent; echo "exit=$?"` → `exit=1`.

- [ ] **Step 3: Extend the type**

```ts
export interface AddDeviceRequest {
  deveui: string;
  name: string;
  type_id: DeviceType;
  appkey?: string;
  strega_generation?: StregaGeneration;
}
```

- [ ] **Step 4: Add the control**, rendered only when the selected type is `STREGA_VALVE`, matching the modal's existing field markup and the valve UI's ≥44 px touch targets, with `id`/`htmlFor` wired so it is reachable by label. Include the field in the submitted payload only for STREGA valves, and reset it wherever the modal resets its other fields.

- [ ] **Step 5: Add locale keys under the modal's real namespace** in every directory `ls` reported. English:

```json
"generation": "Valve generation",
"generationGen1": "Gen1 (standard)",
"generationGen2": "Gen2 / SV2 (Bluetooth)",
"generationHint": "Gen2 valves can also be programmed over Bluetooth. If you are unsure, choose Gen1 — the gateway corrects it automatically on the valve's first reply."
```

German (`de-CH`, no ß): `"Ventil-Generation"`, `"Gen1 (Standard)"`, `"Gen2 / SV2 (Bluetooth)"`, `"Gen2-Ventile lassen sich auch per Bluetooth programmieren. Im Zweifel Gen1 wählen — das Gateway korrigiert die Angabe bei der ersten Antwort des Ventils automatisch."`

French (vouvoiement; terminology locked to *vanne*/*passerelle*): `"Génération de la vanne"`, `"Gen1 (standard)"`, `"Gen2 / SV2 (Bluetooth)"`, `"Les vannes Gen2 se programment aussi par Bluetooth. En cas de doute, choisissez Gen1 : la passerelle corrige automatiquement dès la première réponse de la vanne."`

Remaining locales mirror English (English-only namespaces, tracked by osi-os#168). Merge into the existing namespace object; never create a duplicate key.

- [ ] **Step 6: Verify** — `npx vitest run <file> --silent`, `npm run typecheck`, `npm run test:unit`, each with `echo "exit=$?"`, all 0 and the full suite still green.

- [ ] **Step 7: Commit**

```bash
git add web/react-gui/src/types/farming.ts web/react-gui/src/components/farming/AddDeviceModal.tsx web/react-gui/src/components/farming/__tests__ web/react-gui/public/locales
git commit -m "feat(devices): choose the STREGA generation when registering a valve"
```

---

### Task 6: Reconcile the profile after an ACK, and document

**Files:**
- Modify: `flows.json` node `valve-ack-fn`, both profiles
- Modify: `scripts/test-flows-wiring.js`
- Modify: both system maps, `.claude/skills/osi-config-and-flags/SKILL.md`, `.claude/skills/osi-agronomy-sensors-reference/SKILL.md`, spec §10

**Verified starting state — v1 got this wrong** **[v1 defect]**: `valve-ack-fn.libs` is `[osiLib]` only; `osi-chirpstack-helper` is **not** in osi-lib's `NAME_TO_PATH`; and the node's local variables are not named `result`/`deviceEui`. Read the node and fix the binding before writing any call.

- [ ] **Step 1: Read `valve-ack-fn` and osi-lib's registry**

```bash
node -e "
const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const n=f.find(x=>x.id==='valve-ack-fn'); console.log(JSON.stringify(n.libs)); console.log(n.func);"
grep -n "NAME_TO_PATH" -A 20 conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js
```

Choose the binding deliberately and record the choice: add a direct `libs` entry `{ "var": "chirpstack", "module": "osi-chirpstack-helper" }` (the widespread legacy pattern, ~137 nodes) **or** register the helper in `osi-lib`'s registry and use `osiLib.require('chirpstack')` (the newer seam, and then `verify-helper-registration.js` must pass). Do not write the call before the binding exists.

- [ ] **Step 2: Write the failing wiring assertions** — per profile: `valve-ack-fn` references `setDeviceProfile`, and its `libs` (or the osi-lib registry) actually provide the ChirpStack helper.

- [ ] **Step 3: Run and watch them fail.**

- [ ] **Step 4: Reconcile from stored state, not from a one-shot edge**

`handleUplink` returns `{ acked, generationPromoted }`, but `generationPromoted` is `true` only on the single uplink that flips the row. Reacting to that edge alone means one failed swap is never retried **[reviewer's structural recommendation]**. Instead, after the ACK is recorded, compare stored state against ChirpStack on any STREGA uplink that carried an ACK:

```js
try {
  const settings = await store.getSettings(db, <the node's devEui variable>);
  if (settings && settings.strega_generation === 'GEN2') {
    const gen2Profile = String(env.get('CHIRPSTACK_PROFILE_STREGA_GEN2') || '').trim();
    if (!gen2Profile) {
      node.warn('[valve-ack] ' + <devEui> + ' is GEN2 but CHIRPSTACK_PROFILE_STREGA_GEN2 is unset; profile left on Gen1');
    } else {
      const swapped = await <chirpstack binding>.createProvisioningClientFromEnv(env).setDeviceProfile(<devEui>, gen2Profile);
      if (swapped) node.log('[valve-ack] ' + <devEui> + ' ChirpStack profile re-pointed to Gen2');
    }
  }
} catch (e) {
  node.warn('[valve-ack] ' + <devEui> + ' Gen2 profile reconciliation failed: ' + (e && e.message ? e.message : e));
}
```

Substitute the node's real variable names. `setDeviceProfile` already returns `false` when the profile matches, so a steady-state valve costs one `getDevice` per ACK and no writes. The catch must warn and continue — a failed swap must never lose the ledger write that already happened, and the next ACK retries it.

- [ ] **Step 5: Verify** — the full flows verifier set by exit code, plus `verify-helper-registration.js` if you took the registry route, plus `cmp` on both profiles.

- [ ] **Step 6: Document**

Add to `osi-config-and-flags`: `CHIRPSTACK_PROFILE_STREGA_GEN2` — written by bootstrap, read by `post-devices-insert`, `cs-reg-cloud-fn` and `valve-ack-fn`; provisioned on existing gateways by the one-shot deploy step. Add to `osi-agronomy-sensors-reference`: the two independent axes (`strega_model` vs `strega_generation`), the FPort differences (weekday 14-20 vs daymask 25, clock 12 vs 13), that `OPEN_FOR_DURATION` is identical, and that the Gen2 decoder names the valve field `Actuator`. Add to both system maps: two profiles, generation chosen at registration and self-correcting after the first Gen2 ACK. Add to spec §10 bench gates: register as Gen2 → lands on the Gen2 profile; register an SV2 as Gen1 → first ACK promotes the row **and** re-points the profile; Gen2 telemetry (state, battery) decodes correctly afterwards; a Gen1 valve is unaffected throughout.

- [ ] **Step 7: Prose gate and commit**

```bash
node .claude/skills/anti-slop-writing/slop-check.js docs/architecture/system-map-technical/03-edge-backend-flows.md docs/architecture/system-map/03-edge-backend-flows.md docs/superpowers/specs/2026-08-19-valve-control-design.md; echo "exit=$?"
git add conf docs .claude/skills scripts/test-flows-wiring.js
git commit -m "feat(valves): reconcile the ChirpStack profile for GEN2 valves; document the second profile"
```

---

## Deferred, deliberately

- **Gen2 encoder** (`ChirpStack-JS-CODEC-Encoder-STREGA-Gen2`) stays unshipped: the edge builds downlink bytes itself in `osi-valve-control/plan.js`, and a ChirpStack-side encoder would be a second source of truth for the same frames.
- **The raw-byte Gen2 ACK path stays** even with the Gen2 profile in place — it is what makes a mis-registered valve recoverable, and it is the only Gen2 ACK path with unit-test coverage today.
- **Manual generation changes** in the Valve Settings dialog still do not re-point the profile. Registration and ACK reconciliation cover the real cases; revisit if bench testing shows otherwise.
- ~~A pre-existing Gen1 profile's codec is not corrected~~ — **resolved during Task 3**: `getOrCreateProfileWithCodec` compares the stored codec runtime/script against the desired one and calls `updateDeviceProfile` when they differ, so a drifted profile self-heals on any bootstrap run.
- **Cloud mirror.** AgroLink and OSI Cloud know nothing about valve generation; that belongs to Phase B (edge migration 0024).
