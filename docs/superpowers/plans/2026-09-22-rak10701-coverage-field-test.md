# RAK10701 coverage field test implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A RAK10701 field tester records measured LoRaWAN coverage on the target gateway, shows it on the gateway's map, answers the handheld with live results, and mirrors to the customer cloud host, in time for a customer walk on 25 September 2026.

**Architecture:** The edge already stores radio observations in a dedicated `radio.db` and ships them over history sync v1; the capture gate, the capture flag and the gateway position are broken or missing, and the tester has no device type. This plan repairs the capture path first, adds the device type through the ordered migration runner, anchors the gateway with a static location, closes the loop to the handheld with a six-byte downlink, then builds the walk surface and the cloud mirror.

**Tech Stack:** Node-RED function nodes and `osi-*` helper packages (CommonJS, `node --test`), SQLite with the `lib/osi-migrate` ordered runner, React with `react-leaflet` and i18next, Spring Boot with Flyway on the cloud, FastAPI and React in `osi-planner`.

**Spec:** [docs/superpowers/specs/2026-09-22-rak10701-coverage-field-test-design.md](../specs/2026-09-22-rak10701-coverage-field-test-design.md)

## Global constraints

- Both hardware profiles stay byte-identical: every `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/` change is mirrored to `bcm2709`, enforced by `scripts/verify-profile-parity.js`.
- New GUI strings ship in all seven locales: `de-CH`, `en`, `es`, `fr`, `it`, `lg`, `pt`. French carries the demo. Never overwrite human Luganda.
- The next ordered migration version was `0059` at authoring time. It collided with `main`'s `0059__sync_rejection_recovery.sql` (#351), which landed on `origin/main` after this branch diverged, so the file shipped as `0060` instead — `0059` is left as a deliberate gap for main's file to fill when this branch merges. Migration files are checksummed; never edit a merged one.
- `osi-os` main is a public repository. No customer coordinates, no real GPS fixes, no LoRaWAN keys in committed files. The committed fixture is the synthetic frame below.
- Verified test fixture, a real RAK10701 frame shape with a synthetic position: `data` = `INlJhJz1BdwMCA==`, ten bytes `20 d9 49 84 9c f5 05 dc 0c 08`, decoding to latitude 46.4999993, longitude 6.4999982, altitude 500 m, HDOP 1.2, 8 satellites.
- Target gateway (a Pi 4 gateway) is at schema head 56; the Pi 4 test gateway is at head 53. Both are armv7l Pi 4 hardware.
- Never overwrite `/data/db/farming.db` on either gateway.

---

### Task 1: Repair the field-tester profile gate

The capture node passes `CHIRPSTACK_PROFILE_FIELD_TESTER`, which nothing in the repository sets, and falls back to a profile name equal to `Field Tester` while the provisioned profile is named `OSI RAK Field Tester`. Both tests fail on hardware, so `reported_position` is null for every tester uplink.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/chirpstack.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (node `radio-capture-fn`)
- Mirror both to `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/`
- Test: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/index.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `fromChirpStack(event, context)` where `context.testerProfileIds` is an array of candidate profile UUIDs and `context.testerProfileNamePattern` is a substring matched case-insensitively against `deviceInfo.deviceProfileName`. `context.testerProfileId` and `context.testerProfileName` remain accepted so existing callers and tests keep working.

- [ ] **Step 1: Write the failing test**

Append to `osi-radio-helper/index.test.js`:

```js
test('decodes the tester position from a gateway-realistic environment', () => {
  const frame = {
    time: '2026-09-22T15:36:28.199Z',
    deviceInfo: { devEui: 'ac1f09fffe000001', deviceProfileId: '9b7c33dd-9d24-47a3-b13e-8b050e0ee6de',
      deviceProfileName: 'OSI RAK Field Tester', applicationId: 'app-field-tester' },
    fPort: 1, fCnt: 4, data: 'INlJhJz1BdwMCA==',
    rxInfo: [{ gatewayId: '0016C001F1000002', rssi: -93, snr: 7.75 }],
    txInfo: { frequency: 868100000, modulation: { lora: { spreadingFactor: 12, bandwidth: 125000, codeRate: 'CR_4_5' } } }
  };
  // The gateway exports CHIRPSTACK_PROFILE_RAK10701, never CHIRPSTACK_PROFILE_FIELD_TESTER.
  const byId = fromChirpStack(frame, { gatewayPositions: {}, testerProfileIds: ['9b7c33dd-9d24-47a3-b13e-8b050e0ee6de'] });
  assert.equal(byId.metadata.reported_position.latitude, 46.4999993);
  assert.equal(byId.metadata.reported_position.longitude, 6.4999982);

  // Name fallback must match the provisioned name, which is not equal to 'Field Tester'.
  const byName = fromChirpStack(frame, { gatewayPositions: {}, testerProfileNamePattern: 'field tester' });
  assert.equal(byName.metadata.reported_position.satellites, 8);

  // A non-tester profile must still decode nothing.
  const other = fromChirpStack({ ...frame, deviceInfo: { ...frame.deviceInfo, deviceProfileId: 'other', deviceProfileName: 'OSI KIWI Sensor' } },
    { gatewayPositions: {}, testerProfileIds: ['9b7c33dd-9d24-47a3-b13e-8b050e0ee6de'] });
  assert.equal(other.metadata.reported_position, null);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red
node --test osi-radio-helper/index.test.js
```

Expected: the first assertion fails because `reported_position` is `null`.

- [ ] **Step 3: Widen the gate in `chirpstack.js`**

Replace the `isTester` computation:

```js
  const candidateIds = (context.testerProfileIds || [context.testerProfileId])
    .filter(Boolean).map(id => String(id).trim().toLowerCase());
  const namePattern = String(context.testerProfileNamePattern || context.testerProfileName || '').trim().toLowerCase();
  const profileId = String(device.deviceProfileId || '').trim().toLowerCase();
  const profileName = String(device.deviceProfileName || '').trim().toLowerCase();
  const isTester = (profileId && candidateIds.includes(profileId))
    || (namePattern && profileName.includes(namePattern));
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test osi-radio-helper/index.test.js
```

Expected: all assertions pass, including the existing cases.

- [ ] **Step 5: Point the flow node at the variables the gateway actually exports**

In `flows.json`, node `radio-capture-fn`, replace the `fromChirpStack` call's context:

```js
const row = radio.fromChirpStack(msg.payload, {gatewayPositions, testerProfileIds:[env.get('CHIRPSTACK_PROFILE_RAK10701'), env.get('CHIRPSTACK_PROFILE_CLOVER')], testerProfileNamePattern:'field tester'});
```

Edit the JSON with a script rather than by hand, per `osi-flows-json-editing`, then mirror to `bcm2709`.

- [ ] **Step 6: Verify the flow edit and profile parity**

```bash
cd "$(git rev-parse --show-toplevel)"
node scripts/verify-profile-parity.js
node scripts/verify-no-stray-ddl.js
sh scripts/check-mqtt-topics.sh
```

Expected: parity passes and no stray DDL is reported.

- [ ] **Step 7: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712 conf/full_raspberrypi_bcm27xx_bcm2709
git commit -m "fix(radio): match the field tester by its real profile id and name"
```

---

### Task 2: Make radio capture switchable

`OSI_RADIO_CAPTURE_ENABLED` is read by two function nodes and exported by nothing, so capture cannot be turned on by any supported route.

**Files:**
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init:308-314` and its export block at `:458-464`
- Modify: `docs/contracts/radio-observations/v1.md`

**Interfaces:**
- Consumes: nothing.
- Produces: UCI option `osi-server.cloud.radio_capture_enabled` reaching the Node-RED runtime as `OSI_RADIO_CAPTURE_ENABLED`; absent means off.

- [ ] **Step 1: Resolve the option alongside the ChirpStack values**

After the `cs_profile_s2120` line:

```sh
    local osi_radio_capture=$(resolve_chirpstack_value osi-server.cloud.radio_capture_enabled OSI_RADIO_CAPTURE_ENABLED)
```

- [ ] **Step 2: Export it with the others**

In the same env block as `CHIRPSTACK_PROFILE_S2120`:

```sh
        OSI_RADIO_CAPTURE_ENABLED="$osi_radio_capture" \
```

- [ ] **Step 3: Verify the init script parses**

```bash
sh -n feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 4: Record the operator path in the contract**

Add to `docs/contracts/radio-observations/v1.md`, under the capture-default sentence:

```markdown
Enable per gateway with `uci set osi-server.cloud.radio_capture_enabled='1'; uci commit osi-server`,
then restart Node-RED. Absent or any of `0`, `false`, `off`, `no` keeps capture off.
```

- [ ] **Step 5: Commit**

```bash
git add feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init docs/contracts/radio-observations/v1.md
git commit -m "feat(radio): make capture switchable through UCI"
```

---

### Task 3: Fence tester uplinks out of the telemetry decoders

`CHIRPSTACK_PROFILE_CLOVER` and `CHIRPSTACK_PROFILE_RAK10701` hold the same UUID on both gateways, so the Clover branches claim tester frames. They abort at the `!data.object` guard today because the profile carries no codec, logging one error per uplink; attaching a codec later would turn that into wrong rows.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, nodes `81c98fb07344a787` (Process Data), `8809bb5239dfb3d4` (Build Telemetry), `strega-process-fn` (Process STREGA)
- Mirror to `bcm2709`
- Test: `scripts/verify-sync-flow.js` fixtures

**Interfaces:**
- Consumes: nothing.
- Produces: every telemetry decode node returns `null` before any profile comparison when `deviceInfo.applicationId` equals `CHIRPSTACK_APP_FIELD_TESTER`.

- [ ] **Step 1: Add the guard to each of the three nodes**

As the first statement after the payload is available:

```js
const fieldTesterApp = String(env.get('CHIRPSTACK_APP_FIELD_TESTER') || '').trim().toLowerCase();
const uplinkApp = String((msg.payload && msg.payload.deviceInfo && msg.payload.deviceInfo.applicationId) || '').trim().toLowerCase();
// The RAK10701 shares the Clover profile id by design (chirpstack-bootstrap.js aliases them),
// so the application is the only stable discriminator. Radio capture handles these frames.
if (fieldTesterApp && uplinkApp === fieldTesterApp) return null;
```

- [ ] **Step 2: Verify the flows still load and parity holds**

```bash
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

Expected: `Sync flow verification passed` and `All parity checks passed.`

- [ ] **Step 3: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712 conf/full_raspberrypi_bcm27xx_bcm2709
git commit -m "fix(uplink): keep field tester frames out of the telemetry decoders"
```

---

### Task 4: Add the `RAK10701_FIELD_TESTER` device type

`devices.type_id` is a CHECK constraint with eight types. SQLite cannot alter a CHECK in place, so this is a `destructive` table rebuild following `0027__add_dragino_sdi12_type.sql`. The boot node's `REQUIRED_TYPES` guard compares by set equality and rebuilds `devices` back to its own list on every boot, so it must move in the same commit or the gateway reverts the migration at each restart.

**Files:**
- Create: `database/migrations/ordered/0060__add_rak10701_field_tester_type.sql` (created as `0059__...`, renumbered to `0060` before merge — see the note under Global constraints)
- Modify: `database/seed-blank.sql:99-102`
- Modify: all seven bundled `farming.db` copies
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` node `sync-init-fn` (`REQUIRED_TYPES`) and the `bcm2709` mirror
- Modify: `scripts/verify-db-schema-consistency.js` (`schemaContract`)
- Modify: `web/react-gui/src/types/farming.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `devices.type_id` accepts `RAK10701_FIELD_TESTER`; the GUI `Device['type_id']` union includes it.

- [ ] **Step 1: Copy the precedent migration**

```bash
cd "$(git rev-parse --show-toplevel)"
cp database/migrations/ordered/0027__add_dragino_sdi12_type.sql \
   database/migrations/ordered/0060__add_rak10701_field_tester_type.sql
```

Copy rather than substitute: the precedent file names `DRAGINO_SDI12` both as the type it adds and inside the CHECK list it preserves, so a blind replace would drop an existing type. Edit the copy by hand. Every CHECK list in the file gains `'RAK10701_FIELD_TESTER'` as a ninth entry, and the header reads:

```sql
-- risk: destructive
-- 0060: Add RAK10701_FIELD_TESTER to devices.type_id and rebuild the parent table.
-- The runner supplies the foreign_keys fence and the writers-stopped gate; this
-- file must not toggle foreign_keys itself.
```

Confirm the CHECK block is exactly:

```sql
  type_id                               TEXT NOT NULL CHECK(type_id IN (
                                          'KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50',
                                          'TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN',
                                          'MILESIGHT_UC512','DRAGINO_SDI12','RAK10701_FIELD_TESTER')),
```

- [ ] **Step 2: Apply the same CHECK to `seed-blank.sql`**

Edit `database/seed-blank.sql:99-102` to the nine-type list above.

- [ ] **Step 3: Extend the boot node's `REQUIRED_TYPES`**

In `sync-init-fn`, add `'RAK10701_FIELD_TESTER'` to `REQUIRED_TYPES` and to the `devices_new` CREATE statement's CHECK, in both flows files. Nothing else in that node changes.

- [ ] **Step 4: Regenerate all seven bundled databases**

Do NOT apply the migration to the bundled databases with a raw `sqlite3` invocation. They now ship
ledger-stamped, so a raw apply leaves a database at schema 59 with a ledger at 58 and
`scripts/verify-seed-db-ledger.js` fails. Use `scripts/build-seed-db.js`, which runs `bootstrapFresh`
and then `applyPending(writersStopped: true)` — that path also keeps the rebuild inside the runner's
own `PRAGMA foreign_keys=OFF/ON` fence instead of relying on whatever the CLI's default happens to be.

- [ ] **Step 5: Extend the hand-maintained contract and the GUI union**

In `scripts/verify-db-schema-consistency.js`, add `RAK10701_FIELD_TESTER` wherever the `devices.type_id` CHECK fragment is asserted. In `web/react-gui/src/types/farming.ts`, add `| 'RAK10701_FIELD_TESTER'` to the device type union.

- [ ] **Step 6: Run the full schema gate and paste the output**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/test-journal-schema.js
```

Expected: every script prints its own OK line; the rehearse test passes 4/4.

- [ ] **Step 7: Commit**

```bash
git add database conf web/react-gui/src/types/farming.ts web/react-gui/farming.db scripts/verify-db-schema-consistency.js
git commit -m "feat(devices): add the RAK10701_FIELD_TESTER device type"
```

---

### Task 5: Anchor the gateway with a static location

`gateway_locations` is empty on both gateways and gpsd is not installed on either, so every observation carries receivers with null positions. `receiverPosition` additionally rejects any fix older than 300 s, which a static position can never satisfy.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/chirpstack.js` (`receiverPosition`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-network-api/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (route registration)
- Test: `osi-network-api/index.test.js`, `osi-radio-helper/index.test.js`

**Interfaces:**
- Consumes: the existing `handleRequest` in `osi-network-api/index.js`, plus `receiverPosition` from Task 1's file.
- Produces: `PUT /api/gateway/location` accepting `{latitude, longitude, altitude_m?, accuracy_m?}`, writing `gateway_locations` with `source='static'` and `status='static'`; `receiverPosition` treats `source='static'` as always current.

- [ ] **Step 1: Write the failing freshness test**

```js
test('a static gateway position is not subject to the gpsd freshness window', () => {
  const frame = { time: '2026-09-22T15:36:28.199Z', deviceInfo: { devEui: 'ac1f09fffe000001' }, fPort: 1,
    data: 'INlJhJz1BdwMCA==', rxInfo: [{ gatewayId: '0016C001F1000002', rssi: -93, snr: 7.75 }], txInfo: {} };
  const positions = { '0016C001F1000002': { latitude: 46.5, longitude: 6.5, altitude_m: null,
    source: 'static', last_good_fix_at: '2026-01-01T00:00:00.000Z' } };
  const row = fromChirpStack(frame, { gatewayPositions: positions });
  assert.equal(row.metadata.receivers[0].position.source, 'static');
  assert.equal(row.metadata.receivers[0].position.latitude, 46.5);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red
node --test osi-radio-helper/index.test.js
```

Expected: fails with `position` being `null`, because the fix is months old.

- [ ] **Step 3: Exempt static sources in `receiverPosition`**

Insert before the delta computation:

```js
  // A static position is operator-asserted and does not move, so the gpsd
  // freshness window does not apply to it. gpsd still wins when it has a fix.
  if (row.source === 'static') {
    return {latitude: row.latitude, longitude: row.longitude, altitude_m: row.altitude_m ?? null,
      accuracy_m: row.accuracy_m ?? null, fix_time: row.last_good_fix_at || row.updated_at || null,
      source: 'static', sync_version: row.sync_version ?? null};
  }
```

- [ ] **Step 4: Run it and watch it pass**

```bash
node --test osi-radio-helper/index.test.js
```

- [ ] **Step 5: Write the failing endpoint test**

```js
test('PUT /api/gateway/location stores an operator-asserted static fix', async () => {
  const db = memoryDb();               // same helper the existing tests use
  const res = await handleRequest({ db, method: 'PUT', path: '/api/gateway/location',
    authorization: adminBearer, body: { latitude: 46.5, longitude: 6.5 } });
  assert.equal(res.statusCode, 200);
  const row = await db.get("SELECT source, status, latitude FROM gateway_locations WHERE gateway_device_eui='0016C001F1000001'");
  assert.equal(row.source, 'static');
  assert.equal(row.latitude, 46.5);
});

test('PUT /api/gateway/location rejects an out-of-range coordinate', async () => {
  const res = await handleRequest({ db: memoryDb(), method: 'PUT', path: '/api/gateway/location',
    authorization: adminBearer, body: { latitude: 200, longitude: 6.5 } });
  assert.equal(res.statusCode, 400);
});
```

- [ ] **Step 6: Run it and watch it fail**

```bash
node --test osi-network-api/index.test.js
```

Expected: 404, because the route is not matched.

- [ ] **Step 7: Implement the handler**

In `handleRequest`, before the observations branch:

```js
    if (path === '/api/gateway/location') {
      const user = await actor(db, auth, scoped);
      if (method !== 'PUT') throw error(405, 'method not allowed');
      if (!scope.canMutate(user.role) || user.role !== 'admin') throw error(403, 'insufficient role');
      const identity = await activeInstallation(db);
      const input = bodyOf(request);
      const lat = Number(input.latitude), lon = Number(input.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw error(400, 'invalid coordinate');
      }
      const now = request.now || new Date().toISOString();
      await db.run(
        "INSERT INTO gateway_locations (gateway_device_eui,latitude,longitude,altitude_m,accuracy_m,status,source,last_fix_at,last_good_fix_at,updated_at) " +
        "VALUES (?,?,?,?,?,'static','static',?,?,?) ON CONFLICT(gateway_device_eui) DO UPDATE SET " +
        "latitude=excluded.latitude,longitude=excluded.longitude,altitude_m=excluded.altitude_m," +
        "accuracy_m=excluded.accuracy_m,status='static',source='static',last_fix_at=excluded.last_fix_at," +
        "last_good_fix_at=excluded.last_good_fix_at,updated_at=excluded.updated_at",
        [identity.current_gateway_device_eui, lat, lon,
         input.altitude_m == null ? null : Number(input.altitude_m),
         input.accuracy_m == null ? null : Number(input.accuracy_m), now, now, now]);
      return response(200, { gateway_device_eui: identity.current_gateway_device_eui, latitude: lat, longitude: lon, source: 'static' });
    }
```

- [ ] **Step 8: Run both suites and watch them pass**

```bash
node --test osi-network-api/index.test.js osi-radio-helper/index.test.js
```

- [ ] **Step 9: Register the route in `flows.json`**

Add the `PUT /api/gateway/location` http-in node next to the existing network routes, pointing at the same handler function node, and mirror to `bcm2709`.

- [ ] **Step 10: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712 conf/full_raspberrypi_bcm27xx_bcm2709
git commit -m "feat(network): accept an operator-asserted static gateway position"
```

---

### Task 6: Encode the handheld's six-byte reply

RAK documents the response as six bytes on fPort 2: sequence id as `ID % 255`, minimum RSSI plus 200, maximum RSSI plus 200, minimum distance in 250 m steps, maximum distance in 250 m steps, gateway count. Zero distance means invalid, values below 250 m report as 250 m, and the scale caps at 32 km.

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/fieldtester.js`
- Modify: `osi-radio-helper/index.js` (export it)
- Test: `osi-radio-helper/fieldtester.test.js`
- Mirror to `bcm2709`

**Interfaces:**
- Consumes: the `metadata.receivers` shape produced by `fromChirpStack`.
- Produces: `encodeFieldTesterReply({fCnt, receivers, devicePosition}) -> Buffer | null`, six bytes, `null` when there are no receivers.

- [ ] **Step 1: Write the failing test**

```js
const { encodeFieldTesterReply, haversineMetres } = require('./fieldtester.js');

test('encodes RSSI with the +200 offset and distance in 250 m steps', () => {
  const buf = encodeFieldTesterReply({
    fCnt: 4,
    devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [
      { rssi_dbm: -93, position: { latitude: 46.5045, longitude: 6.5 } },   // ~500 m
      { rssi_dbm: -40, position: { latitude: 46.5, longitude: 6.5 } }       // ~0 m, clamps to 250
    ]
  });
  assert.equal(buf.length, 6);
  assert.equal(buf[0], 4);          // fCnt % 255
  assert.equal(buf[1], 107);        // -93 + 200
  assert.equal(buf[2], 160);        // -40 + 200
  assert.equal(buf[3], 1);          // nearest 250 m step, clamped up from 0
  assert.equal(buf[4], 2);          // ~500 m
  assert.equal(buf[5], 2);          // two receivers
});

test('reports distance as invalid when the gateway position is unknown', () => {
  const buf = encodeFieldTesterReply({ fCnt: 260, devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [{ rssi_dbm: -100, position: null }] });
  assert.equal(buf[0], 5);          // 260 % 255
  assert.equal(buf[3], 0);          // zero means invalid to the device
  assert.equal(buf[4], 0);
  assert.equal(buf[5], 1);
});

test('caps distance at 32 km and clamps RSSI into one byte', () => {
  const buf = encodeFieldTesterReply({ fCnt: 1, devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [{ rssi_dbm: -210, position: { latitude: 47.5, longitude: 6.5 } }] });  // ~111 km
  assert.equal(buf[1], 0);          // clamped, never negative
  assert.equal(buf[4], 128);        // 32000 / 250
});

test('returns null when nothing received the uplink', () => {
  assert.equal(encodeFieldTesterReply({ fCnt: 1, devicePosition: null, receivers: [] }), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test osi-radio-helper/fieldtester.test.js
```

Expected: module not found.

- [ ] **Step 3: Implement the encoder**

```js
'use strict';

// RAK10701 reply, fPort 2, six bytes: sequence id (ID % 255), min RSSI + 200,
// max RSSI + 200, min distance / 250 m, max distance / 250 m, gateway count.
// The device reads a zero distance as invalid, so an unknown gateway position
// sends zero rather than a guess.
const STEP_M = 250;
const MAX_STEPS = 128;            // 32 km

function haversineMetres(a, b) {
  if (!a || !b) return null;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(b.latitude - a.latitude), dLon = toRad(b.longitude - a.longitude);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function steps(metres) {
  if (metres == null || !Number.isFinite(metres)) return 0;
  return Math.max(1, Math.min(MAX_STEPS, Math.round(metres / STEP_M) || 1));
}

function byteRssi(dbm) {
  if (dbm == null || !Number.isFinite(dbm)) return 0;
  return Math.max(0, Math.min(255, Math.round(dbm) + 200));
}

function encodeFieldTesterReply({ fCnt, receivers, devicePosition }) {
  const seen = Array.isArray(receivers) ? receivers : [];
  if (!seen.length) return null;
  const rssis = seen.map(r => r && r.rssi_dbm).filter(v => v != null && Number.isFinite(v));
  const distances = seen
    .map(r => haversineMetres(devicePosition, r && r.position))
    .filter(v => v != null);
  const buf = Buffer.alloc(6);
  buf[0] = Number(fCnt || 0) % 255;
  buf[1] = byteRssi(rssis.length ? Math.min(...rssis) : null);
  buf[2] = byteRssi(rssis.length ? Math.max(...rssis) : null);
  buf[3] = distances.length ? steps(Math.min(...distances)) : 0;
  buf[4] = distances.length ? steps(Math.max(...distances)) : 0;
  buf[5] = Math.min(255, seen.length);
  return buf;
}

module.exports = { encodeFieldTesterReply, haversineMetres };
```

- [ ] **Step 4: Run it and watch it pass**

```bash
node --test osi-radio-helper/fieldtester.test.js
```

- [ ] **Step 5: Export from the helper index and mirror**

Add `fieldtester` to `osi-radio-helper/index.js`'s exports, then copy the whole helper directory to the `bcm2709` mirror.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712 conf/full_raspberrypi_bcm27xx_bcm2709
git commit -m "feat(radio): encode the RAK10701 six-byte reply"
```

---

### Task 7: Send the reply after each tester uplink

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (node `radio-capture-fn`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js` if no downlink enqueue is exported
- Mirror to `bcm2709`

**Interfaces:**
- Consumes: `encodeFieldTesterReply` from Task 6, `fromChirpStack` from Task 1.
- Produces: a queued ChirpStack downlink on fPort 2 for every captured tester uplink whose `reported_position` decoded.

- [ ] **Step 1: Confirm the existing downlink path**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red
grep -n "Enqueue\|enqueue\|DeviceQueue\|queueItem" osi-chirpstack-helper/index.js | head
```

Use the same call the valve path uses. If none is exported, add `enqueueDownlink({devEui, fPort, data, confirmed:false})` wrapping the same gRPC client the helper already builds.

- [ ] **Step 2: Call it from the capture node after `store.capture(normalized)`**

```js
  const reply = radio.fieldtester.encodeFieldTesterReply({fCnt: msg.payload.fCnt, receivers: row.metadata.receivers, devicePosition: row.metadata.reported_position});
  if (reply && row.metadata.reported_position) {
    try { await chirpstack.enqueueDownlink({devEui: row.deveui, fPort: 2, data: reply.toString('base64'), confirmed: false}); }
    catch (e) { node.warn('field tester reply not queued: ' + String(e.message || e)); }
  }
```

The reply is best-effort: a failed downlink must never fail capture, because the stored observation is the product and the handheld display is the convenience.

- [ ] **Step 3: Verify flows and parity**

```bash
cd "$(git rev-parse --show-toplevel)"
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712 conf/full_raspberrypi_bcm27xx_bcm2709
git commit -m "feat(radio): answer the field tester with its coverage result"
```

---

### Task 8: Derive Network visibility from field-tester presence

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-module-defaults/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings/api.js`
- Test: `osi-module-defaults/index.test.js`
- Mirror to `bcm2709`

**Interfaces:**
- Consumes: nothing.
- Produces: `interpretStoredValue(key, rawValue, context)` where `context.fieldTesterPresent` resolves the network module's default; `MODULE_SETTINGS`'s network entry carries `defaultEnabled: 'auto'`.

- [ ] **Step 1: Write the failing test**

```js
test('the network module defaults to the presence of a field tester', () => {
  assert.equal(interpretStoredValue('network_module_enabled', null, { fieldTesterPresent: true }), true);
  assert.equal(interpretStoredValue('network_module_enabled', null, { fieldTesterPresent: false }), false);
});

test('a stored row still wins in both directions', () => {
  assert.equal(interpretStoredValue('network_module_enabled', '0', { fieldTesterPresent: true }), false);
  assert.equal(interpretStoredValue('network_module_enabled', '1', { fieldTesterPresent: false }), true);
});

test('the other three modules keep their static defaults', () => {
  assert.equal(interpretStoredValue('data_module_enabled', null, {}), true);
  assert.equal(interpretStoredValue('journal_module_enabled', null, {}), true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test osi-module-defaults/index.test.js
```

- [ ] **Step 3: Implement the derived default**

Change the network entry to `defaultEnabled: 'auto'`, then:

```js
function moduleDefaultForKey(key, context) {
  const module = SETTING_BY_KEY.get(key);
  if (!module) throw new Error('unknown module setting key: ' + key);
  // 'auto' means the gateway decides from what is registered on it. The caller
  // supplies the facts; this package stays dependency-free.
  if (module.defaultEnabled === 'auto') return Boolean(context && context.fieldTesterPresent);
  return module.defaultEnabled;
}

function interpretStoredValue(key, rawValue, context) {
  if (rawValue === null || rawValue === undefined) return moduleDefaultForKey(key, context);
  return !MODULE_OFF_VALUES.has(String(rawValue).trim().toLowerCase());
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
node --test osi-module-defaults/index.test.js
```

- [ ] **Step 5: Supply the context from the settings route**

In `osi-system-settings/api.js`, before resolving module values:

```js
  const testerRow = await db.get("SELECT 1 AS present FROM devices WHERE type_id='RAK10701_FIELD_TESTER' AND deleted_at IS NULL LIMIT 1");
  const moduleContext = { fieldTesterPresent: Boolean(testerRow && testerRow.present) };
```

Pass `moduleContext` into every `interpretStoredValue` call, and let `PUT` delete the row when the value is the string `auto`.

- [ ] **Step 6: Run the settings suite and commit**

```bash
node --test osi-system-settings/*.test.js
cd "$(git rev-parse --show-toplevel)" && node scripts/verify-profile-parity.js
git add conf/full_raspberrypi_bcm27xx_bcm2712 conf/full_raspberrypi_bcm27xx_bcm2709
git commit -m "feat(settings): show Network when a field tester is registered"
```

---

### Task 9: Coverage view and export on the Network page

**Files:**
- Modify: `web/react-gui/src/pages/NetworkPage.tsx`
- Create: `web/react-gui/src/pages/__tests__/NetworkPageCoverage.test.tsx`
- Modify: `web/react-gui/public/locales/{de-CH,en,es,fr,it,lg,pt}/network.json`

**Interfaces:**
- Consumes: `networkAPI.observations()` and the `parseObservation` export already in the page.
- Produces: `observationsToGeoJSON(rows: NetworkObservation[]): FeatureCollection` exported from `NetworkPage.tsx` for the planner handoff.

- [ ] **Step 1: Write the failing test**

```tsx
import { observationsToGeoJSON } from '../NetworkPage';

it('exports one point feature per positioned observation, carrying RSSI', () => {
  const rows = [
    { recorded_at: '2026-09-25T09:00:00Z', deveui: 'AC1F09FFFE000001', rssi: -93,
      metadata_json: JSON.stringify({ reported_position: { latitude: 46.5, longitude: 6.5 },
        receivers: [{ gateway_id: '0016C001F1000001', rssi_dbm: -93, snr_db: 7.75 }] }) },
    { recorded_at: '2026-09-25T09:01:00Z', deveui: 'AC1F09FFFE000001', rssi: null,
      metadata_json: JSON.stringify({ reported_position: null, receivers: [] }) }
  ] as any;
  const fc = observationsToGeoJSON(rows);
  expect(fc.features).toHaveLength(1);
  expect(fc.features[0].geometry.coordinates).toEqual([6.5, 46.5]);
  expect(fc.features[0].properties.rssi_dbm).toBe(-93);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd web/react-gui && npm run test:unit -- NetworkPageCoverage
```

- [ ] **Step 3: Implement the exporter and the view**

Export `observationsToGeoJSON`, colour each `CircleMarker` by RSSI using five bands from -60 dBm upward, draw the gateway from the first receiver position that resolves, and add a window selector over the existing `hours` query parameter plus a download button producing `coverage-<ISO date>.geojson`.

- [ ] **Step 4: Run it and watch it pass**

```bash
npm run test:unit -- NetworkPage
```

Run the whole page suite, not only the new file, so the existing five tests stay green.

- [ ] **Step 5: Add the strings to all seven locales**

Each `network.json` gains `coverage.title`, `coverage.window`, `coverage.export`, `coverage.legendStrong`, `coverage.legendWeak`, `coverage.noPosition`. Write real French; the demo runs in French.

- [ ] **Step 6: Build once and commit**

```bash
npm run build
cd "$(git rev-parse --show-toplevel)"
git add web/react-gui
git commit -m "feat(gui): show the measured coverage track on the Network page"
```

Only one frontend build at a time on this workstation.

---

### Task 10: Overlay measured points on predicted coverage

**Files:**
- Modify: `/home/phil/Repos/osi-planner/frontend/src/App.tsx`
- Modify: `/home/phil/Repos/osi-planner/backend/planner/api.py` only if the import needs server support
- Test: `/home/phil/Repos/osi-planner/frontend` test suite

**Interfaces:**
- Consumes: the GeoJSON from Task 9.
- Produces: a measured-points layer drawn over the predicted coverage of the open project.

- [ ] **Step 1: Write the failing test**

```js
test('parses a coverage GeoJSON into measured markers', () => {
  const fc = { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [6.5, 46.5] },
      properties: { rssi_dbm: -93, recorded_at: '2026-09-25T09:00:00Z' } }] };
  expect(parseMeasured(fc)).toEqual([{ lat: 46.5, lon: 6.5, rssi: -93, at: '2026-09-25T09:00:00Z' }]);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/phil/Repos/osi-planner/frontend && npm test
```

- [ ] **Step 3: Implement `parseMeasured` plus a file input that draws the layer**

Colour the measured markers on the same RSSI bands the edge page uses, so the two screens read alike.

- [ ] **Step 4: Run the suite and the build**

```bash
npm test && npm run build
```

- [ ] **Step 5: Commit in the planner repository**

```bash
cd /home/phil/Repos/osi-planner
git add frontend
git commit -m "feat: overlay measured coverage points on the predicted map"
```

That repository has no remote. Ask the operator before assuming the commit is backed up anywhere.

---

### Task 11: Cloud device type, sync contract and module rule

**Files:**
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/device/DeviceType.java`
- Modify: `/home/phil/Repos/osi-server/frontend/src/components/farming/deviceRegistry.tsx`
- Modify: the cloud module-visibility resolver added by osi-server #148 and #158

**Interfaces:**
- Consumes: the device type added in Task 4.
- Produces: the cloud accepts a `RAK10701_FIELD_TESTER` DEVICE event, renders it with a name and icon, and its Network module follows field-tester presence with `SUPER_ADMIN` override.

Correction, twice over. The spec first said the cloud entry was cosmetic because nothing under
`backend/src/main/java/org/osi/server/sync/` references `DeviceType.java`. This plan then corrected
that to say `resources.schema.json` gates acceptance and the cloud would reject a field-tester DEVICE
event until the ninth type was vendored. Tracing the actual ingest path shows the first claim was
right and the second was wrong.

`EdgeSyncService.upsertDevice` sets the type through `EdgeStrings.requireBounded(..., 50, ...)`,
which enforces a length bound and nothing else. `Device.type` is `@Column(length = 50)` with no
`@Enumerated`. `V6__convert_device_type_to_varchar.sql` deliberately dropped the native Postgres enum,
in its own words, "so new device types never require a migration. Any string value is now valid." No
JSON-schema validation library is a backend dependency, and the only main-source references to
`resources.schema.json` are javadoc comments. The schema is loaded by test-side code alone, as a
byte-parity CI check.

So the cloud already accepts a `RAK10701_FIELD_TESTER` DEVICE event and always would have. This task
still spans both repositories and the change is still correct — the canonical and vendored copies must
stay byte-identical or the parity gate fails — but it prevents no rejection, and no deployment
ordering depends on it.

- [ ] **Step 1: Add the constant**

```java
    public static final String RAK10701_FIELD_TESTER = "RAK10701_FIELD_TESTER";
```

- [ ] **Step 2: Add the registry entry**

```tsx
  { type: 'RAK10701_FIELD_TESTER', label: 'Field tester', icon: 'radio', category: 'diagnostic' },
```

Match the shape of the neighbouring entries exactly; copy their property names rather than inventing new ones.

- [ ] **Step 3: Apply the same derived default to the cloud module resolver**

Network visible when the installation has a non-deleted `RAK10701_FIELD_TESTER` device, unless a stored preference says otherwise.

- [ ] **Step 4: Run the backend and frontend suites**

```bash
cd /home/phil/Repos/osi-server && ./gradlew test --tests '*Device*' --tests '*Module*'
cd frontend && npm run test:unit
```

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server
git add backend frontend
git commit -m "feat(devices): render the RAK10701 field tester"
```

---

### Task 12: Rehearse on the Pi 4 test gateway

This gateway is armv7l Pi 4 hardware like the target, is not cloud-linked, sits at schema head 53, has an empty `gateway_locations`, and already has the tester joined to it. Deploying here exercises migrations 54 through 59 against a live database before the customer gateway is touched.

**Files:** none. This task is operational; its deliverable is evidence.

- [ ] **Step 1: Deploy through the reverse tunnel**

Follow `osi-live-ops-runbook`: build the GUI, bundle it, serve the repo root on 9876, then download-then-run `deploy.sh` over `ssh -R`. Read the self-check verdict, not the closing banner.

- [ ] **Step 2: Confirm the migration landed**

```bash
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@<gateway-address> \
  "sqlite3 -readonly /data/db/farming.db 'SELECT MAX(version) FROM schema_migrations;'"
```

Expected: `59`.

- [ ] **Step 3: Turn capture on and set the gateway position**

```bash
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@<gateway-address> \
  "uci set osi-server.cloud.radio_capture_enabled='1'; uci commit osi-server; /etc/init.d/node-red restart"
```

Then `PUT /api/gateway/location` with that gateway's own position, authenticated as admin.

- [ ] **Step 4: Register the tester and walk it**

Add the device in the GUI as `RAK10701_FIELD_TESTER` with DevEUI `AC1F09FFFE000001`, then carry the handheld far enough to produce points at more than one RSSI band.

- [ ] **Step 5: Confirm the whole chain**

```bash
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@<gateway-address> \
  "sqlite3 -readonly /data/db/radio.db 'SELECT COUNT(*), MIN(recorded_at), MAX(recorded_at) FROM radio_uplinks;'"
```

Expected: a growing count. Then confirm on the Network page that points carry positions, that the gateway marker draws, and that the handheld's screen shows a gateway count and RSSI.

- [ ] **Step 6: Record the evidence**

Write the observed counts, the handheld reading and any deviation into `docs/superpowers/plans/2026-09-22-rak10701-coverage-field-test-execution.md`.

---

### Task 13: Release the cloud and deploy the target gateway

- [ ] **Step 1: Release `osi-server` to the customer cloud host**

Confirm with the operator in the moment; this is a customer instance. Follow the customer cloud deployment record: tag the image before building, take the full backup, apply Flyway `2026.09.17.001` through `.003`, verify `/locales/fr/network.json` returns 200 afterwards.

- [ ] **Step 2: Deploy the edge build to the target gateway**

Same runbook procedure as Task 12, against <gateway-address>. Expect migrations 57, 58, 59 and 60 to apply, since it sits at head 56.

- [ ] **Step 3: Set the gateway position**

`PUT /api/gateway/location` with the site's surveyed coordinates, altitude omitted. The coordinates
are customer site data, deliberately not committed to this public repository; take them from the
session workspace. The antenna sits about 5 m above ground, which the planner takes as `tx_height_m`; the edge stores no height-above-ground field.

- [ ] **Step 4: Enable capture and cloud sync**

```bash
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@<gateway-address> \
  "uci set osi-server.cloud.radio_capture_enabled='1'; uci set osi-server.cloud.enabled='1'; uci commit osi-server; /etc/init.d/node-red restart"
```

Watch the 6705 queued outbox rows drain, and confirm the radio history stream is either accepted or reported unsupported without stalling the other streams.

The ordering constraint an earlier revision of this plan recorded here is withdrawn. It claimed
cloud sync must wait for Task 11's contract change because the cloud would otherwise reject a
field-tester DEVICE event and retain the rejection. Tracing the ingest path disproved it: the cloud
accepts any type string within the length bound, so enabling sync does not depend on Task 11 at all.

One genuine type-based allow-list does exist nearby and this work does not touch it.
`MqttMessageRouter`'s heartbeat and telemetry handlers hard-code a device-type set that omits
`RAK10701_FIELD_TESTER` — and also `TEKTELIC_CLOVER`, `AQUASCOPE_LORAIN` and `MILESIGHT_UC512`, so the
gap predates this programme. An unrecognised type is silently nulled rather than rejected, and
`DeviceService` then defaults a null type to `KIWI_SENSOR`. A field tester should never traverse that
path, since it carries no telemetry and is fenced out of the decoders, but confirm that during the
rehearsal rather than assuming it.

- [ ] **Step 5: Register the tester on the target**

Provision DevEUI `AC1F09FFFE000001` in that gateway's ChirpStack with the same keys used on the rehearsal gateway, in application `822fc1f9-d90c-4311-a6c9-3166a935457f` on profile `ebc4ad1f-5cec-4214-ba65-c56c26c9742e`, then rejoin the device. Add the `RAK10701_FIELD_TESTER` device row in the GUI.

- [ ] **Step 6: Walk a short loop and confirm before leaving the plan behind**

Points appear with positions, the gateway marker draws at the surveyed position, the handheld shows a gateway count, and the cloud Network page shows the same points.

---

## Cut order

Drop in this order if time runs out: Task 13 Step 1 (the cloud release), then Task 10 (the planner overlay, which can run afterwards from the exported GeoJSON), then Tasks 6 and 7 (the handheld reply). Tasks 1 through 5, 8, 9 and 12 are the walk itself.
