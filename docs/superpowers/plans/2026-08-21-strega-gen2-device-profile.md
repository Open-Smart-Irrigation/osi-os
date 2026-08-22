# STREGA Gen2 (SV2) Device Profile and Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give STREGA Gen2 (SV2) valves their own ChirpStack device profile with the vendor Gen2 decoder, chosen at registration, with automatic profile re-pointing when a valve registered as Gen1 turns out to be Gen2.

**Architecture:** Gen2 is *not* a new device type — one `STREGA_VALVE` type keeps serving both generations, so the frozen boot-node `devices.type_id` CHECK is never touched. A second ChirpStack device profile ("OSI STREGA Valve Gen2") is provisioned alongside the existing one and selected per device at registration from an optional `strega_generation` field (option A). The edge already auto-promotes a valve to `GEN2` when a Gen2-shaped ACK arrives; that same promotion now also re-points the device's ChirpStack profile, which is the self-healing fallback for valves registered under the wrong generation (option B).

**Tech Stack:** Node-RED flows.json function nodes, `osi-chirpstack-helper` (gRPC), `chirpstack-bootstrap.js`, BusyBox ash init script, React 18 + TypeScript + Vite GUI, SQLite (`valve_settings`).

**Spec:** [docs/superpowers/specs/2026-08-19-valve-control-design.md](../specs/2026-08-19-valve-control-design.md) §5 (gateway behaviour, generation handling) and §10 (hardware gates). This plan extends that spec's Gen2 support from "edge protocol only" to "provisioned end to end"; no spec amendment is required, but §10's hardware gates now also cover profile selection.

## Global Constraints

- **No new device type.** `devices.type_id` stays the existing 7-value set. Adding an eighth value forces the frozen `sync-init-fn` boot-node rebuild (`DEVICES_NEW_DDL` / `REQUIRED_TYPES`) and its four-verifier merge gate — out of scope, and the exact trap class as osi-os#173.
- **No schema migration.** `valve_settings.strega_generation TEXT NOT NULL DEFAULT 'GEN1' CHECK (strega_generation IN ('GEN1','GEN2'))` already exists (migration 0022, `database/seed-blank.sql:1051`). Nothing in this plan adds or alters a column.
- **`strega_model` is a different axis.** `devices.strega_model` is `STANDARD`/`MOTORIZED` (hydraulic build, endpoint `PUT /api/devices/:deveui/strega/model`). `valve_settings.strega_generation` is `GEN1`/`GEN2` (protocol generation). Never conflate them, never reuse one endpoint for the other.
- **flows.json is edited only by a one-shot Node script** with the byte-identical roundtrip guard, per the `osi-flows-json-editing` skill. Both profiles must end byte-identical: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (canonical) and `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (mirror).
- **Every gate is judged by exit code** (`node script; echo $?`), never by the last printed line. A verifier in this repo printed a green-looking tail while exiting 1 for two days.
- **No `npm run build`** on the workstation during implementation — frontend builds OOM it. Use `npm run typecheck` and `npm run test:unit`.
- **No STREGA valve exists on any fleet gateway.** Every behaviour in this plan is validated by unit tests and scratch harnesses; hardware validation is deferred to the bench gates in the spec §10. Do not claim hardware verification.
- **Commit but do not push.**

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `conf/.../node-red/codecs/strega_gen2_decoder.js` (new) | Vendor Gen2 decoder, shipped to `/srv/node-red/codecs/` | 1 |
| `conf/.../node-red/chirpstack-bootstrap.js` | Provision the second profile, emit `CHIRPSTACK_PROFILE_STREGA_GEN2` | 1 |
| `conf/.../etc/init.d/osi-bootstrap` | Stamp validation forces one re-bootstrap on already-provisioned gateways | 1 |
| `deploy.sh` | Fetch the new codec file | 1 |
| `flows.json` node `post-devices-insert` | Pick the Gen1/Gen2 profile at registration; seed `valve_settings` | 2 |
| `flows.json` node `valve-ack-fn` | On GEN2 promotion, re-point the ChirpStack device profile | 4 |
| `conf/.../node-red/osi-chirpstack-helper/index.js` | New `updateDeviceProfileAssignment(devEui, profileId)` | 4 |
| `web/react-gui/src/types/farming.ts` | `AddDeviceRequest.strega_generation` | 3 |
| `web/react-gui/src/components/farming/AddDeviceModal.tsx` | Generation choice, STREGA-only | 3 |
| `web/react-gui/public/locales/*/devices.json` | Generation labels, 7 locales | 3 |
| `docs/architecture/system-map*/`, `AGENTS.md`, `.claude/skills/osi-config-and-flags/SKILL.md` | Document the second profile and the env var | 5 |

---

### Task 1: Ship the Gen2 codec and provision the second ChirpStack profile

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen2_decoder.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/strega_gen2_decoder.js` (byte-identical mirror)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js` (+ bcm2709 mirror)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap` (+ bcm2709 mirror)
- Modify: `deploy.sh:623-624` region
- Source: `docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up`

**Interfaces:**
- Produces: env var `CHIRPSTACK_PROFILE_STREGA_GEN2` written to `/srv/node-red/.chirpstack.env`; ChirpStack profile named `OSI STREGA Valve Gen2`. Tasks 2 and 4 read this env var.

- [ ] **Step 1: Copy the vendored decoder into the shipped codec set**

The vendor file has no extension and may carry CRLF endings. Normalise it, do not rewrite its logic:

```bash
cd /home/phil/Repos/osi-os
SRC="docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up"
DST2712="conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen2_decoder.js"
DST2709="conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/strega_gen2_decoder.js"
sed 's/\r$//' "$SRC" > "$DST2712"
cp "$DST2712" "$DST2709"
cmp "$DST2712" "$DST2709" && echo "mirror byte-identical"
```

- [ ] **Step 2: Verify the decoder parses and exposes `decodeUplink`**

ChirpStack 4.x calls `decodeUplink({fPort, bytes, variables})`. Confirm the vendored file defines it (older vendor codecs sometimes define only `Decode`/`decode`):

```bash
node --check conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen2_decoder.js; echo "syntax exit=$?"
grep -n "function decodeUplink\|decodeUplink\s*=" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen2_decoder.js
```

Expected: syntax exit=0 and at least one `decodeUplink` hit. **If `decodeUplink` is absent, STOP and report** — the codec needs a vendor-faithful wrapper, which is a decision for the operator, not an improvisation.

- [ ] **Step 3: Add the codec path and profile name to the bootstrap config block**

In `chirpstack-bootstrap.js`, the `CFG` object near line 88 holds profile names and codec paths. Add two entries beside the existing STREGA ones:

```js
  profileStregaGen2Name: process.env.CS_PROFILE_STREGA_GEN2_NAME || 'OSI STREGA Valve Gen2',
  stregaGen2CodecPath: process.env.STREGA_GEN2_CODEC_PATH || '/srv/node-red/codecs/strega_gen2_decoder.js',
```

Add the matching lines to the header comment block (the `CS_PROFILE_STREGA_NAME` / `STREGA_CODEC_PATH` documentation near lines 36 and 42), and bump the "7 device profiles" count in the line-7 comment to 8.

- [ ] **Step 4: Provision the profile and export its id**

In the `[ 4/5 ] Device profiles` section (near line 446), immediately after the existing `stregaProfileId` line:

```js
  const stregaGen2CodecScript = readCodecScript(CFG.stregaGen2CodecPath, 'STREGA Gen2');
  const stregaGen2ProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileStregaGen2Name, 'Strega SV2 smart irrigation valve, Gen2 scheduler (LoRaWAN 1.0.3 OTAA)', stregaGen2CodecScript);
```

In the `envVars` object (near line 471), after `CHIRPSTACK_PROFILE_STREGA`:

```js
    CHIRPSTACK_PROFILE_STREGA_GEN2: stregaGen2ProfileId,
```

In the summary print block (near line 498), after the existing STREGA line:

```js
  console.log(`    ${CFG.profileStregaGen2Name.padEnd(24)} ${stregaGen2ProfileId}`);
```

Mirror the finished file to bcm2709 and `cmp` it.

- [ ] **Step 5: Force one re-bootstrap on already-provisioned gateways**

`conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap` line 11 validates the stamp by grepping for one env key only. A gateway provisioned before this change has a valid stamp and would never learn about the Gen2 profile. Add a second grep directly after line 11:

```sh
	grep -q 'CHIRPSTACK_PROFILE_STREGA_GEN2=[0-9a-f]\{8\}-' /srv/node-red/.chirpstack.env 2>/dev/null || return 1
```

`chirpstack-bootstrap.js` is idempotent (`getOrCreateProfileWithCodec`), so the forced re-run creates only the missing profile and rewrites the env file. Mirror to bcm2709 and `cmp`.

- [ ] **Step 6: Fetch the codec at deploy time**

In `deploy.sh`, directly after the `strega_gen1_decoder.js` fetch block (lines 623-624), following that block's exact two-argument style:

```sh
  fetch_required \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen2_decoder.js" \
    "/srv/node-red/codecs/strega_gen2_decoder.js"
```

Read the surrounding lines first and match the real function name and indentation — do not trust this snippet's `fetch_required` if the file uses a different helper.

- [ ] **Step 7: Run the deploy-wiring and communication verifiers**

```bash
cd /home/phil/Repos/osi-os
for s in scripts/verify-communication-contract.js scripts/verify-profile-parity.js; do node "$s" >/dev/null 2>&1; echo "$s exit=$?"; done
ls scripts/ | grep -i deploy   # run every deploy-wiring test the repo has, same way
```

Expected: every script exit=0. If a deploy-wiring test asserts a fetched-file inventory, it must now include the Gen2 codec — update that fixture in this task.

- [ ] **Step 8: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen2_decoder.js \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/strega_gen2_decoder.js \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap \
        deploy.sh
git commit -m "feat(chirpstack): provision a STREGA Gen2 device profile with the vendor decoder"
```

---

### Task 2: Select the profile at registration and seed the valve generation

**Files:**
- Modify: `flows.json` node `post-devices-insert` ("Insert or Claim Device"), both profiles
- Modify: `scripts/test-flows-wiring.js` (new assertions)
- Test: scratch harness under the session scratchpad (not committed)

**Interfaces:**
- Consumes: env `CHIRPSTACK_PROFILE_STREGA_GEN2` (Task 1).
- Consumes: request body field `strega_generation` (`'GEN1'` | `'GEN2'` | absent), produced by Task 3's GUI.
- Produces: registration writes `valve_settings.strega_generation` for STREGA devices, so the scheduler's first push uses the right frames.

- [ ] **Step 1: Read the node before editing it**

```bash
cd /home/phil/Repos/osi-os
node -e "
const flows=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const n=flows.find(x=>x.id==='post-devices-insert');
console.log(n.func);
" | head -120
```

The node reads `flow.get('new_device_*')` values, builds `appMap`/`profileMap` keyed by `type_id`, and validates before inserting. Note exactly how the upstream node populates `flow` context — the generation must travel the same way as `new_device_appkey`.

- [ ] **Step 2: Write the failing wiring assertions**

Append to `scripts/test-flows-wiring.js`, in the style of the existing `H2*` sections (read one first; per-profile loop, `OK`/`FAIL` lines, `process.exitCode = 1` on failure):

```js
// H3: STREGA Gen2 profile selection at registration
for (const profilePath of FLOWS_PATHS) {
  const flows = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const node = flows.find((n) => n.id === 'post-devices-insert');
  if (!node) { fail('H3', profilePath + ': post-devices-insert missing'); continue; }
  if (!/CHIRPSTACK_PROFILE_STREGA_GEN2/.test(node.func)) {
    fail('H3a', profilePath + ': registration does not read CHIRPSTACK_PROFILE_STREGA_GEN2');
  } else { ok('H3a', profilePath + ': Gen2 profile env read at registration'); }
  if (!/INSERT INTO valve_settings/.test(node.func)) {
    fail('H3b', profilePath + ': registration does not seed valve_settings.strega_generation');
  } else { ok('H3b', profilePath + ': valve_settings seeded at registration'); }
}
```

Adapt `FLOWS_PATHS`, `ok()` and `fail()` to the file's real helper names.

- [ ] **Step 3: Run the wiring test to verify it fails**

```bash
node scripts/test-flows-wiring.js >/dev/null 2>&1; echo "exit=$?"
```

Expected: `exit=1` with the two H3 FAIL lines visible when run without redirection.

- [ ] **Step 4: Add generation-aware profile selection**

Edit `post-devices-insert` via a one-shot script. Immediately after the `profileMap` object, add:

```js
const stregaGeneration = String(flow.get('new_device_strega_generation') || '').trim().toUpperCase();
if (type_id === 'STREGA_VALVE' && stregaGeneration === 'GEN2') {
  const gen2Profile = String(env.get('CHIRPSTACK_PROFILE_STREGA_GEN2') || '').trim();
  if (gen2Profile) {
    profileMap.STREGA_VALVE = gen2Profile;
  } else {
    node.warn('[devices] CHIRPSTACK_PROFILE_STREGA_GEN2 unset; registering ' + deveui + ' on the Gen1 profile');
  }
}
```

The warn-and-continue is deliberate: a gateway whose bootstrap has not yet re-run must still be able to register a valve, and Task 4's promotion path repairs the profile on the first Gen2 ACK.

- [ ] **Step 5: Seed `valve_settings` for STREGA registrations**

After the successful `devices` INSERT in the same node, and only when `type_id === 'STREGA_VALVE'`:

```js
await db.run(
  "INSERT INTO valve_settings (device_eui, strega_generation) VALUES (?, ?) " +
  "ON CONFLICT(device_eui) DO UPDATE SET strega_generation = excluded.strega_generation",
  [deveui, stregaGeneration === 'GEN2' ? 'GEN2' : 'GEN1']
);
```

Confirm the real primary-key column name and the table's conflict target first:

```bash
grep -n "CREATE TABLE IF NOT EXISTS valve_settings" -A 14 database/seed-blank.sql
```

Use whatever that shows; do not assume `device_eui` if the file says otherwise. The node already opens and closes a DB handle — reuse it and do not add a second `new osiDb.Database`, or the wiring test's close-audit fails.

- [ ] **Step 6: Thread the field from the HTTP handler into flow context**

Find the node that sets `new_device_appkey` (it is upstream of `post-devices-insert`, reachable by grepping `new_device_appkey` across the flows) and set the generation the same way:

```js
flow.set('new_device_strega_generation', String(body.strega_generation || '').trim().toUpperCase());
```

Validate it: an unknown non-empty value must be rejected with 400 rather than silently treated as GEN1.

```js
const gen = String(body.strega_generation || '').trim().toUpperCase();
if (gen && gen !== 'GEN1' && gen !== 'GEN2') {
  msg.statusCode = 400;
  msg.payload = { message: 'strega_generation must be GEN1 or GEN2' };
  return [null, msg];
}
```

- [ ] **Step 7: Prove the behaviour with a scratch harness**

Extract the node's `func`, stub `flow`/`env`/`node`/`msg`, and run it against a `node:sqlite` DB created from `database/seed-blank.sql`. Assert four cases:

1. `type_id='STREGA_VALVE'`, generation `'GEN2'`, env set → device created with the Gen2 profile id, `valve_settings.strega_generation = 'GEN2'`.
2. Same, generation `'GEN1'` → Gen1 profile id, `valve_settings.strega_generation = 'GEN1'`.
3. Same, generation absent → Gen1 profile id and `'GEN1'` (default, no crash).
4. `'GEN2'` requested but `CHIRPSTACK_PROFILE_STREGA_GEN2` unset → Gen1 profile id, a warn emitted, registration still succeeds.

Paste the harness output into the task report.

- [ ] **Step 8: Run the full flows verifier set**

```bash
cd /home/phil/Repos/osi-os
cmp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
    conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json; echo "cmp exit=$?"
for s in scripts/test-flows-wiring.js scripts/verify-no-new-silent-catch.js scripts/flows-bare-require-scan.js \
         scripts/verify-flows-size-ratchet.js scripts/verify-communication-contract.js \
         scripts/verify-no-stray-ddl.js scripts/verify-flows-fn-parse.js scripts/verify-profile-parity.js \
         scripts/verify-sync-flow.js; do
  node "$s" >/dev/null 2>&1; echo "$s exit=$?"
done
```

Expected: every line `exit=0`. If the size ratchet fails, add a **byte-counted** allowance entry in `scripts/verify-flows-size-ratchet-allowances.json` measured against `origin/main`, never a rounded-up guess.

- [ ] **Step 9: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-flows-wiring.js scripts/verify-flows-size-ratchet-allowances.json
git commit -m "feat(devices): pick the STREGA profile by generation at registration"
```

---

### Task 3: Ask for the generation in the add-device flow

**Files:**
- Modify: `web/react-gui/src/types/farming.ts:164-169`
- Modify: `web/react-gui/src/components/farming/AddDeviceModal.tsx`
- Modify: `web/react-gui/public/locales/{en,de,fr,es,it,pt,lg}/devices.json`
- Test: `web/react-gui/src/components/farming/__tests__/` (follow the directory's existing harness)

**Interfaces:**
- Produces: `AddDeviceRequest.strega_generation?: StregaGeneration` on `POST /api/devices`, consumed by Task 2.
- Consumes: the existing `StregaGeneration` union already exported from `web/react-gui/src/types/farming.ts` (used by `ValveSettingsDialog`). Reuse it; do not declare a second union.

- [ ] **Step 1: Write the failing component tests**

Add to the add-device test file in `web/react-gui/src/components/farming/__tests__/` (read a sibling test for the render/mock harness first — do not invent a new one):

```tsx
it('offers a generation choice only for STREGA valves', async () => {
  render(<AddDeviceModal {...baseProps} />);
  await userEvent.selectOptions(screen.getByLabelText(/device type/i), 'SENSECAP_S2120');
  expect(screen.queryByLabelText(/generation/i)).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText(/device type/i), 'STREGA_VALVE');
  expect(screen.getByLabelText(/generation/i)).toBeInTheDocument();
});

it('submits the selected generation for a STREGA valve', async () => {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  render(<AddDeviceModal {...baseProps} onAdd={onAdd} />);
  await userEvent.selectOptions(screen.getByLabelText(/device type/i), 'STREGA_VALVE');
  await userEvent.type(screen.getByLabelText(/deveui/i), '00DEC0DE00000001');
  await userEvent.type(screen.getByLabelText(/name/i), 'Vanne 1');
  await userEvent.selectOptions(screen.getByLabelText(/generation/i), 'GEN2');
  await userEvent.click(screen.getByRole('button', { name: /add|hinzuf|ajouter/i }));
  expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ strega_generation: 'GEN2' }));
});

it('omits the generation field for non-STREGA devices', async () => {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  render(<AddDeviceModal {...baseProps} onAdd={onAdd} />);
  await userEvent.selectOptions(screen.getByLabelText(/device type/i), 'SENSECAP_S2120');
  await userEvent.type(screen.getByLabelText(/deveui/i), '2CF7F1C073400206');
  await userEvent.type(screen.getByLabelText(/name/i), 'Wetterstation');
  await userEvent.click(screen.getByRole('button', { name: /add|hinzuf|ajouter/i }));
  expect(onAdd).toHaveBeenCalledWith(expect.not.objectContaining({ strega_generation: expect.anything() }));
});
```

Match the real prop names, label text and submit-button accessible name from the component — adjust the queries, keep the assertions.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd web/react-gui && npx vitest run src/components/farming/__tests__ --silent; echo "exit=$?"
```

Expected: exit=1, the three new tests failing on a missing generation control.

- [ ] **Step 3: Extend the request type**

In `web/react-gui/src/types/farming.ts`:

```ts
export interface AddDeviceRequest {
  deveui: string;
  name: string;
  type_id: DeviceType;
  appkey?: string;
  strega_generation?: StregaGeneration;
}
```

- [ ] **Step 4: Add the control to the modal**

In `AddDeviceModal.tsx`, hold the state beside the existing fields and render the control only for STREGA valves, matching the modal's existing field markup, label style and ≥44 px touch-target sizing used elsewhere in the valve UI:

```tsx
const [stregaGeneration, setStregaGeneration] = useState<StregaGeneration>('GEN1');
```

```tsx
{typeId === 'STREGA_VALVE' && (
  <div>
    <label htmlFor="add-device-generation" className="...match sibling labels...">
      {t('addDevice.generation')}
    </label>
    <select
      id="add-device-generation"
      value={stregaGeneration}
      onChange={(event) => setStregaGeneration(event.target.value as StregaGeneration)}
      className="...match sibling inputs, min-h-[44px]..."
    >
      <option value="GEN1">{t('addDevice.generationGen1')}</option>
      <option value="GEN2">{t('addDevice.generationGen2')}</option>
    </select>
    <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t('addDevice.generationHint')}</p>
  </div>
)}
```

In the submit handler, include the field only for STREGA valves:

```tsx
const payload: AddDeviceRequest = { deveui, name, type_id: typeId, ...(appkey ? { appkey } : {}) };
if (typeId === 'STREGA_VALVE') payload.strega_generation = stregaGeneration;
await onAdd(payload);
```

Reset `stregaGeneration` to `'GEN1'` wherever the modal resets its other fields.

- [ ] **Step 5: Add the locale keys to all seven locales**

`en/devices.json`:

```json
"addDevice": {
  "generation": "Valve generation",
  "generationGen1": "Gen1 (standard)",
  "generationGen2": "Gen2 / SV2 (Bluetooth)",
  "generationHint": "Gen2 valves can also be programmed over Bluetooth. If you are unsure, choose Gen1 — the gateway corrects it automatically on the valve's first reply."
}
```

`de/devices.json` (de-CH: no ß):

```json
"addDevice": {
  "generation": "Ventil-Generation",
  "generationGen1": "Gen1 (Standard)",
  "generationGen2": "Gen2 / SV2 (Bluetooth)",
  "generationHint": "Gen2-Ventile lassen sich auch per Bluetooth programmieren. Im Zweifel Gen1 wählen — das Gateway korrigiert die Angabe bei der ersten Antwort des Ventils automatisch."
}
```

`fr/devices.json` (vouvoiement, terminology locked to *vanne*):

```json
"addDevice": {
  "generation": "Génération de la vanne",
  "generationGen1": "Gen1 (standard)",
  "generationGen2": "Gen2 / SV2 (Bluetooth)",
  "generationHint": "Les vannes Gen2 se programment aussi par Bluetooth. En cas de doute, choisissez Gen1 : la passerelle corrige automatiquement dès la première réponse de la vanne."
}
```

`es`, `it`, `pt`, `lg`: mirror the English text verbatim (these namespaces are English-only today, tracked by osi-os#168). Merge into the existing `addDevice` object if one already exists; do not create a duplicate key.

- [ ] **Step 6: Run the tests and typecheck**

```bash
cd web/react-gui
npx vitest run src/components/farming/__tests__ --silent; echo "vitest exit=$?"
npm run typecheck; echo "typecheck exit=$?"
npm run test:unit; echo "test:unit exit=$?"
```

Expected: all three exit=0, with the full suite still green (≥707 tests).

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/types/farming.ts \
        web/react-gui/src/components/farming/AddDeviceModal.tsx \
        web/react-gui/src/components/farming/__tests__ \
        web/react-gui/public/locales
git commit -m "feat(devices): choose the STREGA generation when registering a valve"
```

---

### Task 4: Re-point the ChirpStack profile when a valve is promoted to Gen2

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js` (+ bcm2709 mirror)
- Modify: `flows.json` node `valve-ack-fn` ("Valve ACK ledger"), both profiles
- Modify: `scripts/test-flows-wiring.js`

**Interfaces:**
- Consumes: `handleUplink(...)` already returns `{ acked, generationPromoted }` (`osi-valve-control/workers.js:26`). No module change is needed — the flag exists.
- Consumes: env `CHIRPSTACK_PROFILE_STREGA_GEN2` (Task 1).
- Produces: `client.setDeviceProfile(devEui, deviceProfileId)` on the ChirpStack helper.

- [ ] **Step 1: Write the failing helper test**

The helper has `createDevice`, `getDevice`, `deleteDevice` and key methods, but **no device-update method** (`updateDeviceProfile` at line 427 updates a *profile object*, not a device's assignment — do not reuse it). Add a test beside the helper's existing tests (find them with `ls conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/`; if the module has no test file, place the test with the osi-lib loader tests and follow that harness):

```js
test('setDeviceProfile preserves the device and swaps only its profile', async () => {
  const captured = {};
  const client = makeStubClient(captured, {
    get: { device: { devEui: '00dec0de00000001', name: 'Vanne 1', applicationId: 'app-1', deviceProfileId: 'prof-gen1' } }
  });
  const changed = await client.setDeviceProfile('00DEC0DE00000001', 'prof-gen2');
  assert.equal(changed, true);
  assert.equal(captured.update.device.deviceProfileId, 'prof-gen2');
  assert.equal(captured.update.device.name, 'Vanne 1');
  assert.equal(captured.update.device.applicationId, 'app-1');
});

test('setDeviceProfile is a no-op when the profile already matches', async () => {
  const captured = {};
  const client = makeStubClient(captured, {
    get: { device: { devEui: '00dec0de00000001', deviceProfileId: 'prof-gen2' } }
  });
  assert.equal(await client.setDeviceProfile('00DEC0DE00000001', 'prof-gen2'), false);
  assert.equal(captured.update, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper
node --test .; echo "exit=$?"
```

Expected: exit=1, `client.setDeviceProfile is not a function`.

- [ ] **Step 3: Implement `setDeviceProfile`**

In `ChirpStackClient`, after `deleteDevice` (line 255 region). ChirpStack's `update` replaces the whole device object, so it must be read first and mutated — dropping fields here would silently wipe the device's name or application:

```js
  async setDeviceProfile(devEui, deviceProfileId) {
    const targetId = String(deviceProfileId || '').trim();
    if (!targetId) throw new Error('setDeviceProfile: deviceProfileId is required');
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

Mirror the file to bcm2709 and `cmp`.

- [ ] **Step 4: Run the helper tests**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper
node --test .; echo "exit=$?"
```

Expected: exit=0, both new tests passing.

- [ ] **Step 5: Call it from the ACK node on promotion**

`valve-ack-fn` already binds `osiLib` and the ChirpStack helper (verify its `libs` array before assuming). After it consumes `handleUplink`'s result:

```js
if (result && result.generationPromoted) {
  const gen2Profile = String(env.get('CHIRPSTACK_PROFILE_STREGA_GEN2') || '').trim();
  if (!gen2Profile) {
    node.warn('[valve-ack] ' + deviceEui + ' promoted to GEN2 but CHIRPSTACK_PROFILE_STREGA_GEN2 is unset; ChirpStack profile left on Gen1');
  } else {
    try {
      const csClient = chirpstack.createProvisioningClientFromEnv(env);
      const swapped = await csClient.setDeviceProfile(deviceEui, gen2Profile);
      node.log('[valve-ack] ' + deviceEui + ' ChirpStack profile ' + (swapped ? 're-pointed to Gen2' : 'already Gen2'));
    } catch (e) {
      node.warn('[valve-ack] ' + deviceEui + ' Gen2 profile re-point failed: ' + (e && e.message ? e.message : e));
    }
  }
}
```

The catch must warn and continue: a failed re-point must never lose the ACK ledger write that already happened. The DB promotion is the source of truth for scheduling; the profile swap only fixes telemetry decoding.

- [ ] **Step 6: Add the wiring assertions**

Append to `scripts/test-flows-wiring.js`, per-profile, in the file's existing style: assert `valve-ack-fn`'s `func` contains both `generationPromoted` and `setDeviceProfile`, and that its `libs` array binds the ChirpStack helper. Verify each assertion bites by mutating a scratch copy of the flows file, never the repo copy.

- [ ] **Step 7: Run the full verifier set**

```bash
cd /home/phil/Repos/osi-os
cmp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
    conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json; echo "cmp exit=$?"
for s in scripts/test-flows-wiring.js scripts/verify-no-new-silent-catch.js scripts/flows-bare-require-scan.js \
         scripts/verify-flows-size-ratchet.js scripts/verify-communication-contract.js scripts/verify-no-stray-ddl.js \
         scripts/verify-flows-fn-parse.js scripts/verify-profile-parity.js scripts/verify-helper-registration.js \
         scripts/verify-sync-flow.js; do
  node "$s" >/dev/null 2>&1; echo "$s exit=$?"
done
```

Expected: every line exit=0.

- [ ] **Step 8: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-flows-wiring.js
git commit -m "feat(valves): re-point the ChirpStack profile when a valve is promoted to Gen2"
```

---

### Task 5: Document the second profile and extend the hardware gates

**Files:**
- Modify: `docs/architecture/system-map-technical/03-edge-backend-flows.md`, `docs/architecture/system-map/03-edge-backend-flows.md`
- Modify: `.claude/skills/osi-config-and-flags/SKILL.md`
- Modify: `.claude/skills/osi-agronomy-sensors-reference/SKILL.md` (STREGA section)
- Modify: `docs/superpowers/specs/2026-08-19-valve-control-design.md` §10

- [ ] **Step 1: Document the env var and the profile pair**

In `.claude/skills/osi-config-and-flags/SKILL.md`, beside the existing `CHIRPSTACK_PROFILE_*` documentation, add `CHIRPSTACK_PROFILE_STREGA_GEN2` with: written by `chirpstack-bootstrap.js`; selects the Gen2 decoder profile; consumed by `post-devices-insert` (registration) and `valve-ack-fn` (promotion re-point); a gateway missing the key re-bootstraps once because the `osi-bootstrap` stamp check now greps for it.

- [ ] **Step 2: Record the generation-vs-model distinction**

In `.claude/skills/osi-agronomy-sensors-reference/SKILL.md`'s STREGA section, state plainly that `devices.strega_model` (`STANDARD`/`MOTORIZED`) and `valve_settings.strega_generation` (`GEN1`/`GEN2`) are independent axes, that the generation drives FPort selection (Gen1 weekday 14-20 vs Gen2 daymask 25, clock 12 vs 13), and that `OPEN_FOR_DURATION` is identical on both.

- [ ] **Step 3: Update both system maps**

Add to the Valve Control section of each map: two ChirpStack profiles exist, the generation is chosen at registration and self-corrects on the first Gen2 ACK, and Gen2 ACK detection reads raw bytes so scheduling works even when a valve sits on the wrong profile.

- [ ] **Step 4: Extend the spec's hardware gates**

In §10 of the spec, add gates that a bench session must run with a real SV2: register a valve as Gen2 and confirm it lands on the Gen2 profile in ChirpStack; register an SV2 deliberately as Gen1 and confirm the first ACK both promotes `valve_settings.strega_generation` and re-points the ChirpStack profile; confirm Gen2 telemetry (battery, state) decodes correctly once the profile is right; confirm a Gen1 valve is untouched by all of this.

- [ ] **Step 5: Run the prose gate**

```bash
cd /home/phil/Repos/osi-os
node .claude/skills/anti-slop-writing/slop-check.js \
  docs/architecture/system-map-technical/03-edge-backend-flows.md \
  docs/architecture/system-map/03-edge-backend-flows.md \
  docs/superpowers/specs/2026-08-19-valve-control-design.md; echo "exit=$?"
```

Expected: `slop-check: PASS`, exit=0.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture .claude/skills/osi-config-and-flags/SKILL.md \
        .claude/skills/osi-agronomy-sensors-reference/SKILL.md \
        docs/superpowers/specs/2026-08-19-valve-control-design.md
git commit -m "docs: STREGA Gen2 profile, generation-vs-model axes, bench gates"
```

---

## Deferred, deliberately

- **Gen2 encoder.** `docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Encoder-STREGA-Gen2` stays unshipped. The edge builds downlink frames itself in `osi-valve-control/plan.js` and enqueues raw hex, so a ChirpStack-side encoder would be a second, divergent source of truth for the same bytes.
- **Removing the raw-byte Gen2 ACK path.** It stays even once the Gen2 profile exists: it is what makes a mis-registered valve recoverable, and it is the only path proven by unit tests today.
- **Re-pointing on manual generation change.** Flipping the dropdown in the Valve Settings dialog updates `valve_settings` but does not swap the ChirpStack profile. Registration and auto-promotion cover the real cases; a manual override that also swaps the profile can follow if bench testing shows it is needed.
- **Cloud mirror.** AgroLink/OSI Cloud know nothing about valve generation. That belongs to the Phase B sync work (edge migration 0024), not here.
