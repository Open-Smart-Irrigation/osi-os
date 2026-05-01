# LSN50 Chameleon Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist decoded LSN50 Chameleon payloads into the local edge database with a Chameleon-specific readings table, while preserving existing LSN50 `device_data` behavior and avoiding dendrometer regressions.

**Architecture:** Keep the existing ChirpStack → LSN50 decode → LSN50 `device_data` insert path. Add a dedicated `chameleon_readings` table for the 44-byte Chameleon payload fields and insert into it from a new Node-RED function after the generic LSN50 row is stored. Chameleon payloads must bypass dendrometer derived metrics even if an old device record still has `dendro_enabled=1`.

**Tech Stack:** Node-RED function nodes in `flows.json`, SQLite `/data/db/farming.db`, existing `osi-db-helper`, Node.js verification scripts, bundled seed SQLite databases.

---

## Scope

In scope:
- Local edge SQLite persistence for Chameleon V1 payloads.
- A new `chameleon_readings` table keyed by `deveui` + `recorded_at` index.
- Normalized Chameleon fields on `msg.formattedData`.
- Regression protection so Chameleon MOD=3 payloads do not enter dendrometer analytics.
- Verification scripts for decoder normalization, flow schema, and insert SQL behavior.

Out of scope:
- GUI rendering.
- OSI Server schema/API changes.
- kPa conversion.
- Calibration coefficient storage.
- Cloud sync handling for the new Chameleon-specific table.

Design note: kPa conversion is near-term, but this plan stores the payload's ohm values only. Add kPa columns in the conversion task when coefficient ownership and status semantics are implemented. The dedicated table keeps that later migration small.

Review consolidation decisions:
- `device_data.lsn50_mode_code` and `device_data.lsn50_mode_label` stay aligned to the stock LSN50 observed AT mode. For Chameleon firmware frames this is still MOD3 / `3ADC+IIC`; do not invent a Chameleon mode code in this step. Chameleon identity is carried by `d.isChameleon` during flow processing and by `chameleon_readings.payload_version` in the dedicated table.
- Chameleon temperature is stored in `chameleon_readings.temp_c` independently of the legacy LSN50 `temp_enabled` flag. Existing generic `device_data.ext_temperature_c` behavior remains governed by the current LSN50 flow.
- If `i2c_missing` or `timeout` is set, persist the status bits but store `NULL` for `temp_c`, all resistance fields, and `array_id`. This prevents naive consumers from plotting fault-path zeroes as real measurements. If only `temp_fault` is set, store `NULL` for `temp_c` while preserving resistance and array-id values.
- Raw resistance `9999999` with clean status flags is treated as dry/saturated connected-sensor data, not as the open-circuit sentinel. The firmware sentinel remains `10000000`.
- `payload_b64` stores `data.data`, the LoRaWAN FRMPayload base64 from ChirpStack, not the full ChirpStack event envelope.
- `f_port` and `f_cnt` are nullable. Confirm the exact ChirpStack v4 event field names (`data.fPort` / `data.fCnt` versus alternatives) against a real uplink during implementation.

---

## File Map

Modify:
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
  - `sync-init-fn`: create `chameleon_readings` and indexes.
  - `lsn50-decode-fn`: normalize decoded `Chameleon_*` fields into `msg.formattedData`.
  - `lsn50-apply-config`: bypass dendrometer conversion when `d.isChameleon === true`.
  - Add `chameleon-readings-insert-fn`: insert Chameleon rows directly via `osi-db-helper`.
  - Wire `lsn50-zone-agg-fn` → `chameleon-readings-insert-fn` → `dendro-readings-insert-fn`.
  - `dendro-readings-insert-fn`: skip Chameleon payloads defensively.
- `scripts/verify-sync-flow.js`
  - Assert local schema migration and flow wiring.
- `scripts/verify-lsn50-chameleon-codec.js`
  - Add dry-connected `9999999` raw-resistance fixture coverage if not already present.

Create:
- `scripts/verify-lsn50-chameleon-persistence.js`
  - Static and behavior checks for table schema, flow normalization, insert function, and dendrometer bypass.

Modify bundled DB seeds:
- `database/farming.db`
- `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db`
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
- `conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
- `web/react-gui/farming.db`

---

## Table Schema

Create this table idempotently in `sync-init-fn`:

```sql
CREATE TABLE IF NOT EXISTS chameleon_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_version INTEGER,
  status_flags INTEGER,
  i2c_missing INTEGER DEFAULT 0,
  timeout INTEGER DEFAULT 0,
  temp_fault INTEGER DEFAULT 0,
  id_fault INTEGER DEFAULT 0,
  ch1_open INTEGER DEFAULT 0,
  ch2_open INTEGER DEFAULT 0,
  ch3_open INTEGER DEFAULT 0,
  temp_c REAL,
  r1_ohm_comp INTEGER,
  r2_ohm_comp INTEGER,
  r3_ohm_comp INTEGER,
  r1_ohm_raw INTEGER,
  r2_ohm_raw INTEGER,
  r3_ohm_raw INTEGER,
  array_id TEXT,
  adc_ch0v REAL,
  adc_ch1v REAL,
  adc_ch4v REAL,
  bat_v REAL,
  payload_b64 TEXT,
  f_port INTEGER,
  f_cnt INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_chameleon_readings_deveui_time
  ON chameleon_readings(deveui, recorded_at);

CREATE INDEX IF NOT EXISTS idx_chameleon_readings_array_id
  ON chameleon_readings(array_id);
```

Do not add a unique constraint yet. Existing `device_data` accepts every uplink row; match that behavior until we have a verified deduplication key across ChirpStack versions.

---

## Task 1: Add Persistence Verifier First

**Files:**
- Create: `scripts/verify-lsn50-chameleon-persistence.js`

- [ ] **Step 1: Create the verifier script**

Write `scripts/verify-lsn50-chameleon-persistence.js`:

```js
#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const flowsPath = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));

function nodeById(id) {
  const node = flows.find((entry) => entry.id === id);
  assert(node, `missing flow node ${id}`);
  return node;
}

function funcOf(id) {
  const node = nodeById(id);
  assert.strictEqual(node.type, 'function', `${id} must be a function node`);
  return String(node.func || '');
}

function assertIncludes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label}: expected to find ${needle}`);
}

function compileFunctionNode(id) {
  const source = funcOf(id);
  new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${source}\n})`);
}

async function runFunctionNode(id, msg) {
  const source = funcOf(id);
  const writes = [];
  const statuses = [];
  const errors = [];
  let closeCount = 0;

  class FakeDatabase {
    constructor(dbPath) {
      this.dbPath = dbPath;
    }

    run(sql, params, callback) {
      writes.push({ dbPath: this.dbPath, sql, params });
      callback(null);
    }

    close(callback) {
      closeCount += 1;
      callback(null);
    }
  }

  const fn = new vm.Script(`(async function(msg,node){${source}\n})`).runInNewContext({
    osiDb: { Database: FakeDatabase },
    Buffer,
    Number,
    String,
    console,
    Promise
  });

  const result = await fn(msg, {
    status(value) { statuses.push(value); },
    error(value) { errors.push(value); },
    warn(value) { errors.push(value); }
  });

  return { result, writes, statuses, errors, closeCount };
}

const syncInit = funcOf('sync-init-fn');
assertIncludes(syncInit, 'CREATE TABLE IF NOT EXISTS chameleon_readings', 'schema creates chameleon_readings');
assertIncludes(syncInit, 'idx_chameleon_readings_deveui_time', 'schema indexes by device/time');
assertIncludes(syncInit, 'idx_chameleon_readings_array_id', 'schema indexes array id');

const decode = funcOf('lsn50-decode-fn');
assertIncludes(decode, 'isChameleon', 'decode marks chameleon payloads');
assertIncludes(decode, 'Chameleon_Payload_Version', 'decode reads payload version');
assertIncludes(decode, 'chameleonR1OhmComp', 'decode normalizes R1 compensated');
assertIncludes(decode, 'chameleonR1OhmRaw', 'decode normalizes R1 raw');
assertIncludes(decode, 'Chameleon_Array_ID', 'decode normalizes array id');

const apply = funcOf('lsn50-apply-config');
assertIncludes(apply, '} else if (d.isChameleon === true) {', 'chameleon branch sits between MOD9 and dendrometer logic');
assertIncludes(apply, 'temp_enabled is a legacy LSN50/dendrometer gate', 'chameleon branch documents temp_enabled handling');
assertIncludes(apply, 'Chameleon flags 0x', 'apply-config surfaces chameleon status flags');
assertIncludes(apply, 'd.dendroValid = null', 'chameleon branch keeps dendrometer insert guard closed');
assertIncludes(apply, 'd.dendroCalibrationMissing = false;\n    flow.set(prevKey, undefined);', 'chameleon branch clears dendrometer previous state');

const chameleonInsert = funcOf('chameleon-readings-insert-fn');
assertIncludes(chameleonInsert, 'if (!d || d.isChameleon !== true) return msg;', 'insert passes non-chameleon payloads downstream');
assertIncludes(chameleonInsert, 'INSERT INTO chameleon_readings', 'insert function writes chameleon table');
assertIncludes(chameleonInsert, 'r1_ohm_comp', 'insert stores compensated resistance');
assertIncludes(chameleonInsert, 'r1_ohm_raw', 'insert stores raw resistance');
assertIncludes(chameleonInsert, 'payload_b64', 'insert stores raw payload for replay');
assertIncludes(chameleonInsert, 'rawPayloadB64 is ChirpStack data.data', 'insert documents payload_b64 replay semantics');
assertIncludes(chameleonInsert, 'const tempInvalid = dataInvalid || toInt(d.chameleonTempFault) === 1;', 'insert explicitly nulls temp_c on temp_fault');
assertIncludes(chameleonInsert, 'return msg;', 'insert function passes through downstream flow');

const dendroInsert = funcOf('dendro-readings-insert-fn');
assertIncludes(dendroInsert, 'd.isChameleon === true', 'dendrometer insert skips chameleon frames');

const zoneAgg = nodeById('lsn50-zone-agg-fn');
const zoneAggTargets = (zoneAgg.wires && zoneAgg.wires[0]) || [];
assert(zoneAggTargets.includes('chameleon-readings-insert-fn'), 'zone agg first output must feed chameleon insert');
const chameleonInsertNode = nodeById('chameleon-readings-insert-fn');
const chameleonTargets = (chameleonInsertNode.wires && chameleonInsertNode.wires[0]) || [];
assert(chameleonTargets.includes('dendro-readings-insert-fn'), 'chameleon insert must pass through to dendro insert');

compileFunctionNode('lsn50-decode-fn');
compileFunctionNode('lsn50-apply-config');
compileFunctionNode('chameleon-readings-insert-fn');
compileFunctionNode('dendro-readings-insert-fn');

(async () => {
  const passThroughMsg = { formattedData: { devEui: 'AA', isChameleon: false } };
  const passThrough = await runFunctionNode('chameleon-readings-insert-fn', passThroughMsg);
  assert.strictEqual(passThrough.result, passThroughMsg, 'non-chameleon payload passes through unchanged');
  assert.strictEqual(passThrough.writes.length, 0, 'non-chameleon payload does not write chameleon_readings');

  const normalMsg = {
    formattedData: {
      devEui: 'a84041ffffffffff',
      timestamp: '2026-05-01T10:00:00.000Z',
      isChameleon: true,
      chameleonPayloadVersion: 1,
      chameleonStatusFlags: 0,
      chameleonI2cMissing: 0,
      chameleonTimeout: 0,
      chameleonTempFault: 0,
      chameleonIdFault: 0,
      chameleonCh1Open: 0,
      chameleonCh2Open: 0,
      chameleonCh3Open: 0,
      chameleonTempC: 28.43,
      chameleonR1OhmComp: 1168,
      chameleonR2OhmComp: 10257,
      chameleonR3OhmComp: 101195,
      chameleonR1OhmRaw: 1168,
      chameleonR2OhmRaw: 10257,
      chameleonR3OhmRaw: 101195,
      chameleonArrayId: '286D6ADB0F0000F1',
      adcV: 0.085,
      adcCh1V: 0.521,
      adcCh4V: 0.002,
      batV: 3.6,
      rawPayloadB64: 'AAECAwQ=',
      fPort: 2,
      fCnt: 123
    }
  };
  const normal = await runFunctionNode('chameleon-readings-insert-fn', normalMsg);
  assert.strictEqual(normal.result, normalMsg, 'normal chameleon payload passes downstream');
  assert.strictEqual(normal.writes.length, 1, 'normal chameleon payload writes one row');
  assert(normal.writes[0].sql.includes('INSERT INTO chameleon_readings'), 'normal write targets chameleon_readings');
  assert.strictEqual(normal.writes[0].params.length, 26, 'normal write uses all insert parameters');
  assert.strictEqual(normal.writes[0].params[0], 'A84041FFFFFFFFFF', 'devEui is stored uppercase');
  assert.strictEqual(normal.writes[0].params[11], 28.43, 'temp_c is stored for valid data');
  assert.strictEqual(normal.writes[0].params[12], 1168, 'r1_ohm_comp is stored for valid data');
  assert.strictEqual(normal.writes[0].params[15], 1168, 'r1_ohm_raw is stored for valid data');
  assert.strictEqual(normal.writes[0].params[18], '286D6ADB0F0000F1', 'array_id is stored for valid data');
  assert.strictEqual(normal.writes[0].params[23], 'AAECAwQ=', 'payload_b64 stores the LoRaWAN payload base64');
  assert.strictEqual(normal.writes[0].params[24], 2, 'f_port is stored when present');
  assert.strictEqual(normal.writes[0].params[25], 123, 'f_cnt is stored when present');
  assert.strictEqual(normal.closeCount, 1, 'normal write closes the database handle');

  const faultMsg = JSON.parse(JSON.stringify(normalMsg));
  faultMsg.formattedData.chameleonI2cMissing = 1;
  faultMsg.formattedData.chameleonStatusFlags = 1;
  faultMsg.formattedData.chameleonTempC = 0;
  faultMsg.formattedData.chameleonR1OhmComp = 0;
  faultMsg.formattedData.chameleonR1OhmRaw = 0;
  faultMsg.formattedData.chameleonArrayId = 'SHOULD_NOT_STORE';
  const fault = await runFunctionNode('chameleon-readings-insert-fn', faultMsg);
  assert.strictEqual(fault.writes.length, 1, 'fault chameleon payload still writes one row');
  assert.strictEqual(fault.writes[0].params[4], 1, 'i2c_missing flag is persisted');
  assert.strictEqual(fault.writes[0].params[11], null, 'temp_c is nulled when data is invalid');
  assert.strictEqual(fault.writes[0].params[12], null, 'r1_ohm_comp is nulled when data is invalid');
  assert.strictEqual(fault.writes[0].params[15], null, 'r1_ohm_raw is nulled when data is invalid');
  assert.strictEqual(fault.writes[0].params[18], null, 'array_id is nulled when data is invalid');

  const tempFaultMsg = JSON.parse(JSON.stringify(normalMsg));
  tempFaultMsg.formattedData.chameleonTempFault = 1;
  tempFaultMsg.formattedData.chameleonStatusFlags = 4;
  tempFaultMsg.formattedData.chameleonTempC = 0;
  const tempFault = await runFunctionNode('chameleon-readings-insert-fn', tempFaultMsg);
  assert.strictEqual(tempFault.writes[0].params[6], 1, 'temp_fault flag is persisted');
  assert.strictEqual(tempFault.writes[0].params[11], null, 'temp_c is nulled on temp_fault');
  assert.strictEqual(tempFault.writes[0].params[12], 1168, 'r1_ohm_comp is preserved on temp_fault-only frames');
  assert.strictEqual(tempFault.writes[0].params[18], '286D6ADB0F0000F1', 'array_id is preserved on temp_fault-only frames');

  const emptyFieldMsg = JSON.parse(JSON.stringify(normalMsg));
  emptyFieldMsg.formattedData.chameleonTempC = '';
  emptyFieldMsg.formattedData.chameleonR1OhmComp = '';
  emptyFieldMsg.formattedData.fCnt = undefined;
  const emptyFields = await runFunctionNode('chameleon-readings-insert-fn', emptyFieldMsg);
  assert.strictEqual(emptyFields.writes[0].params[11], null, 'empty temp string stores NULL');
  assert.strictEqual(emptyFields.writes[0].params[12], null, 'empty resistance string stores NULL');
  assert.strictEqual(emptyFields.writes[0].params[25], null, 'missing fCnt stores NULL');

  console.log('LSN50 Chameleon persistence checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Make it executable**

Run:

```bash
chmod +x scripts/verify-lsn50-chameleon-persistence.js
```

- [ ] **Step 3: Run and confirm it fails before implementation**

Run:

```bash
node scripts/verify-lsn50-chameleon-persistence.js
```

Expected: failure mentioning missing `chameleon_readings` or missing `chameleon-readings-insert-fn`.

- [ ] **Step 4: Commit the failing verifier**

```bash
git add scripts/verify-lsn50-chameleon-persistence.js
git commit -m "test(chameleon): add persistence flow verifier"
```

---

## Task 2: Add Local Schema Migration

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Test: `scripts/verify-lsn50-chameleon-persistence.js`

- [ ] **Step 1: Add schema statements to `sync-init-fn`**

In the `stmts` array of `sync-init-fn`, after the `dendrometer_readings` schema block, add these strings:

```js
"CREATE TABLE IF NOT EXISTS chameleon_readings(id INTEGER PRIMARY KEY AUTOINCREMENT,deveui TEXT NOT NULL,recorded_at TEXT NOT NULL,payload_version INTEGER,status_flags INTEGER,i2c_missing INTEGER DEFAULT 0,timeout INTEGER DEFAULT 0,temp_fault INTEGER DEFAULT 0,id_fault INTEGER DEFAULT 0,ch1_open INTEGER DEFAULT 0,ch2_open INTEGER DEFAULT 0,ch3_open INTEGER DEFAULT 0,temp_c REAL,r1_ohm_comp INTEGER,r2_ohm_comp INTEGER,r3_ohm_comp INTEGER,r1_ohm_raw INTEGER,r2_ohm_raw INTEGER,r3_ohm_raw INTEGER,array_id TEXT,adc_ch0v REAL,adc_ch1v REAL,adc_ch4v REAL,bat_v REAL,payload_b64 TEXT,f_port INTEGER,f_cnt INTEGER,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),FOREIGN KEY(deveui) REFERENCES devices(deveui) ON DELETE CASCADE)",
"CREATE INDEX IF NOT EXISTS idx_chameleon_readings_deveui_time ON chameleon_readings(deveui,recorded_at)",
"CREATE INDEX IF NOT EXISTS idx_chameleon_readings_array_id ON chameleon_readings(array_id)",
```

Do not add a sync outbox trigger for `chameleon_readings` in this task. That would change the cloud data-plane contract and belongs with OSI Server support.

- [ ] **Step 2: Run verifier and confirm remaining failures**

```bash
node scripts/verify-lsn50-chameleon-persistence.js
```

Expected: schema checks pass; later checks still fail.

- [ ] **Step 3: Commit schema change**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git commit -m "feat(chameleon): add local readings table schema"
```

---

## Task 3: Normalize Chameleon Fields in LSN50 Decode

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Test: `scripts/verify-lsn50-chameleon-persistence.js`

- [ ] **Step 1: Add normalization helpers inside `lsn50-decode-fn`**

Inside `lsn50-decode-fn`, near the existing local variables, add:

```js
function chameleonNumber(value) {
    if (value === null || value === undefined || value === '' || value === 'NULL') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function chameleonInteger(value) {
    const numeric = chameleonNumber(value);
    return numeric === null ? null : Math.trunc(numeric);
}

function chameleonFlag(value) {
    if (value === true) return 1;
    if (value === false) return 0;
    if (value === 1 || value === '1') return 1;
    if (value === 0 || value === '0') return 0;
    return null;
}

function chameleonString(value) {
    if (value === null || value === undefined || value === '' || value === 'NULL') return null;
    return String(value);
}
```

- [ ] **Step 2: Extract decoded Chameleon fields from `data.object`**

Inside the existing `if (data.object && typeof data.object === 'object')` block, after ADC extraction, add:

```js
        const hasChameleon = obj.Chameleon_Payload_Version !== undefined && obj.Chameleon_Payload_Version !== null;
        if (hasChameleon) {
            msg._chameleonDecoded = {
                isChameleon: true,
                payloadVersion: chameleonInteger(obj.Chameleon_Payload_Version),
                statusFlags: chameleonInteger(obj.Chameleon_Status_Flags),
                i2cMissing: chameleonFlag(obj.Chameleon_I2C_Missing),
                timeout: chameleonFlag(obj.Chameleon_Timeout),
                tempFault: chameleonFlag(obj.Chameleon_Temp_Fault),
                idFault: chameleonFlag(obj.Chameleon_ID_Fault),
                ch1Open: chameleonFlag(obj.Chameleon_CH1_Open),
                ch2Open: chameleonFlag(obj.Chameleon_CH2_Open),
                ch3Open: chameleonFlag(obj.Chameleon_CH3_Open),
                tempC: chameleonNumber(obj.Chameleon_TempC),
                r1OhmComp: chameleonInteger(obj.Chameleon_R1_Ohm_Comp),
                r2OhmComp: chameleonInteger(obj.Chameleon_R2_Ohm_Comp),
                r3OhmComp: chameleonInteger(obj.Chameleon_R3_Ohm_Comp),
                r1OhmRaw: chameleonInteger(obj.Chameleon_R1_Ohm_Raw),
                r2OhmRaw: chameleonInteger(obj.Chameleon_R2_Ohm_Raw),
                r3OhmRaw: chameleonInteger(obj.Chameleon_R3_Ohm_Raw),
                arrayId: chameleonString(obj.Chameleon_Array_ID)
            };
        }
```

- [ ] **Step 3: Add normalized fields to `msg.formattedData`**

Inside the same outer `try` block, immediately after the `msg.formattedData = { ... }` object is created and before the existing `node.status(...)` / `return msg`, merge the decoded fields:

```js
    const chameleonDecoded = msg._chameleonDecoded || null;
    if (chameleonDecoded) {
        Object.assign(msg.formattedData, {
            isChameleon: true,
            chameleonPayloadVersion: chameleonDecoded.payloadVersion,
            chameleonStatusFlags: chameleonDecoded.statusFlags,
            chameleonI2cMissing: chameleonDecoded.i2cMissing,
            chameleonTimeout: chameleonDecoded.timeout,
            chameleonTempFault: chameleonDecoded.tempFault,
            chameleonIdFault: chameleonDecoded.idFault,
            chameleonCh1Open: chameleonDecoded.ch1Open,
            chameleonCh2Open: chameleonDecoded.ch2Open,
            chameleonCh3Open: chameleonDecoded.ch3Open,
            chameleonTempC: chameleonDecoded.tempC,
            chameleonR1OhmComp: chameleonDecoded.r1OhmComp,
            chameleonR2OhmComp: chameleonDecoded.r2OhmComp,
            chameleonR3OhmComp: chameleonDecoded.r3OhmComp,
            chameleonR1OhmRaw: chameleonDecoded.r1OhmRaw,
            chameleonR2OhmRaw: chameleonDecoded.r2OhmRaw,
            chameleonR3OhmRaw: chameleonDecoded.r3OhmRaw,
            chameleonArrayId: chameleonDecoded.arrayId,
            rawPayloadB64: msg._rawPayload,
            fPort: chameleonInteger(data.fPort),
            fCnt: chameleonInteger(data.fCnt)
        });
    }
```

Keep raw `9999999` resistance values numeric when the decoder does not mark a channel open.

Confirm `data.fPort` and `data.fCnt` against one real ChirpStack v4 uplink while implementing. If either field is absent in the event shape, keep the corresponding normalized value as `null`.

- [ ] **Step 4: Run verifier**

```bash
node scripts/verify-lsn50-chameleon-persistence.js
```

Expected: decode checks pass; insert and wiring checks still fail.

- [ ] **Step 5: Commit decode normalization**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git commit -m "feat(chameleon): normalize decoded LSN50 chameleon fields"
```

---

## Task 4: Bypass Dendrometer Derivation for Chameleon Payloads

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Test: `scripts/verify-lsn50-chameleon-persistence.js`

- [ ] **Step 1: Add Chameleon branch in `lsn50-apply-config`**

In `lsn50-apply-config`, after the MOD9 branch and before the existing non-MOD9 dendrometer logic, add a Chameleon branch:

```js
} else if (d.isChameleon === true) {
    // temp_enabled is a legacy LSN50/dendrometer gate; Chameleon temperature is stored in chameleon_readings.temp_c.
    d.modeCodeToStore = d.observedModeCode != null ? d.observedModeCode : effectiveMode;
    d.modeLabelToStore = d.observedModeLabel != null ? d.observedModeLabel : dendro.lsn50ModeLabel(effectiveMode);
    if (!d.observedModeObservedAt && d.observedModeCode != null) {
        d.observedModeObservedAt = d.timestamp;
    }

    d.positionRawMm = null;
    d.positionMm = null;
    d.positionUm = null;
    d.dendroValid = null;
    d.deltaMm = null;
    d.dendroRatio = null;
    d.dendroModeUsed = null;
    d.dendroStemChangeUm = null;
    d.dendroSaturated = 0;
    d.dendroSaturationSide = null;
    d.dendroCalibrationMissing = false;
    flow.set(prevKey, undefined);

    const parts = [];
    if (d.chameleonStatusFlags != null) parts.push('Chameleon flags 0x' + Number(d.chameleonStatusFlags).toString(16).toUpperCase());
    if (d.chameleonTempC != null) parts.push('T ' + d.chameleonTempC.toFixed(2) + ' C');
    if (d.chameleonR1OhmComp != null) parts.push('R1 ' + d.chameleonR1OhmComp + ' ohm');
    if (d.chameleonR2OhmComp != null) parts.push('R2 ' + d.chameleonR2OhmComp + ' ohm');
    if (d.chameleonR3OhmComp != null) parts.push('R3 ' + d.chameleonR3OhmComp + ' ohm');
    node.status({ fill: d.chameleonStatusFlags ? 'yellow' : 'blue', shape: 'dot', text: parts.join(' | ') || 'Chameleon' });
```

Make the following original non-MOD9 branch become the final `else { ... }`.

This branch intentionally preserves stock mode storage: `d.modeCodeToStore` and `d.modeLabelToStore` remain the observed MOD3 / `3ADC+IIC` values. The Chameleon distinction is not encoded as a new LSN50 mode.

- [ ] **Step 2: Add defensive skip to `dendro-readings-insert-fn`**

At the top of `dendro-readings-insert-fn`, change:

```js
if (!d || d.detectedMode === 9) return null;
```

to:

```js
if (!d || d.detectedMode === 9 || d.isChameleon === true) return null;
```

The existing second guard in `dendro-readings-insert-fn` already skips rows when `d.dendroValid` is `null`, and the Chameleon branch sets that value. Keep the explicit `d.isChameleon === true` check anyway as a readable defensive gate, not as the only protection.

- [ ] **Step 3: Run verifier**

```bash
node scripts/verify-lsn50-chameleon-persistence.js
```

Expected: apply-config and dendrometer skip checks pass; insert and wiring checks still fail.

- [ ] **Step 4: Commit Chameleon/dendrometer separation**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git commit -m "fix(chameleon): keep chameleon payloads out of dendrometer analytics"
```

---

## Task 5: Insert Chameleon Readings

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Test: `scripts/verify-lsn50-chameleon-persistence.js`

- [ ] **Step 1: Add `chameleon-readings-insert-fn` node**

Add a new Node-RED function node on the LSN50 tab. Use this JavaScript as the node `func`; JSON-escape it when inserting into `flows.json`:

```js
return (async()=>{
const d = msg.formattedData;
if (!d || d.isChameleon !== true) return msg;

function toNum(v) { return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); }
function toInt(v) { const n = toNum(v); return n === null ? null : Math.trunc(n); }
function toStr(v) { return v === null || v === undefined || v === '' ? null : String(v); }

const dataInvalid = toInt(d.chameleonI2cMissing) === 1 || toInt(d.chameleonTimeout) === 1;
const tempInvalid = dataInvalid || toInt(d.chameleonTempFault) === 1;
const tempC = tempInvalid ? null : toNum(d.chameleonTempC);
const arrayId = dataInvalid ? null : toStr(d.chameleonArrayId);
const r1OhmComp = dataInvalid ? null : toInt(d.chameleonR1OhmComp);
const r2OhmComp = dataInvalid ? null : toInt(d.chameleonR2OhmComp);
const r3OhmComp = dataInvalid ? null : toInt(d.chameleonR3OhmComp);
const r1OhmRaw = dataInvalid ? null : toInt(d.chameleonR1OhmRaw);
const r2OhmRaw = dataInvalid ? null : toInt(d.chameleonR2OhmRaw);
const r3OhmRaw = dataInvalid ? null : toInt(d.chameleonR3OhmRaw);

const db = new osiDb.Database('/data/db/farming.db');
const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
const close = () => new Promise((resolve) => db.close(() => resolve()));

try {
  await run(
    'INSERT INTO chameleon_readings (deveui,recorded_at,payload_version,status_flags,i2c_missing,timeout,temp_fault,id_fault,ch1_open,ch2_open,ch3_open,temp_c,r1_ohm_comp,r2_ohm_comp,r3_ohm_comp,r1_ohm_raw,r2_ohm_raw,r3_ohm_raw,array_id,adc_ch0v,adc_ch1v,adc_ch4v,bat_v,payload_b64,f_port,f_cnt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      String(d.devEui || '').trim().toUpperCase(),
      toStr(d.timestamp),
      toInt(d.chameleonPayloadVersion),
      toInt(d.chameleonStatusFlags),
      toInt(d.chameleonI2cMissing),
      toInt(d.chameleonTimeout),
      toInt(d.chameleonTempFault),
      toInt(d.chameleonIdFault),
      toInt(d.chameleonCh1Open),
      toInt(d.chameleonCh2Open),
      toInt(d.chameleonCh3Open),
      tempC,
      r1OhmComp,
      r2OhmComp,
      r3OhmComp,
      r1OhmRaw,
      r2OhmRaw,
      r3OhmRaw,
      arrayId,
      toNum(d.adcV),
      toNum(d.adcCh1V),
      toNum(d.adcCh4V),
      toNum(d.batV),
      // rawPayloadB64 is ChirpStack data.data: base64 LoRaWAN FRMPayload for offline replay.
      toStr(d.rawPayloadB64),
      toInt(d.fPort),
      toInt(d.fCnt)
    ]
  );
  node.status({ fill: d.chameleonStatusFlags ? 'yellow' : 'green', shape: 'dot', text: 'Chameleon stored ' + d.devEui });
  return msg;
} catch (error) {
  node.status({ fill: 'red', shape: 'ring', text: 'Chameleon persist failed' });
  node.error('Chameleon persistence failed: ' + String(error && error.message ? error.message : error), msg);
  return msg;
} finally {
  try { await close(); } catch (_) {}
}
})().catch((error) => {
  node.error('Chameleon persistence failed: ' + String(error && error.message ? error.message : error), msg);
  return msg;
});
```

Node metadata:
- `id`: `chameleon-readings-insert-fn`
- `type`: `function`
- `z`: `lsn50-tab`
- `name`: `Insert Chameleon Reading`
- `outputs`: `1`
- `libs`: `[{ "var": "osiDb", "module": "osi-db-helper" }]`
- `wires`: `[[ "dendro-readings-insert-fn" ]]`

Adjust `x`/`y` to fit the LSN50 tab layout if nearby nodes overlap.

- [ ] **Step 2: Rewire the LSN50 path**

Change `lsn50-zone-agg-fn` wires from:

```json
[["dendro-readings-insert-fn"]]
```

to:

```json
[["chameleon-readings-insert-fn"]]
```

The new function returns `msg` for non-Chameleon payloads, so existing dendrometer behavior still runs.

- [ ] **Step 3: Run verifier**

```bash
node scripts/verify-lsn50-chameleon-persistence.js
```

Expected: `LSN50 Chameleon persistence checks passed`.

- [ ] **Step 4: Commit insert flow**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git commit -m "feat(chameleon): persist decoded readings to local sqlite"
```

---

## Task 6: Update Seed Databases

**Files:**
- Modify: `database/farming.db`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
- Modify: `conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
- Modify: `web/react-gui/farming.db`

- [ ] **Step 1: Apply schema to each seed DB**

Run:

```bash
for db in \
  database/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  web/react-gui/farming.db
do
  sqlite3 "$db" "
    CREATE TABLE IF NOT EXISTS chameleon_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deveui TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload_version INTEGER,
      status_flags INTEGER,
      i2c_missing INTEGER DEFAULT 0,
      timeout INTEGER DEFAULT 0,
      temp_fault INTEGER DEFAULT 0,
      id_fault INTEGER DEFAULT 0,
      ch1_open INTEGER DEFAULT 0,
      ch2_open INTEGER DEFAULT 0,
      ch3_open INTEGER DEFAULT 0,
      temp_c REAL,
      r1_ohm_comp INTEGER,
      r2_ohm_comp INTEGER,
      r3_ohm_comp INTEGER,
      r1_ohm_raw INTEGER,
      r2_ohm_raw INTEGER,
      r3_ohm_raw INTEGER,
      array_id TEXT,
      adc_ch0v REAL,
      adc_ch1v REAL,
      adc_ch4v REAL,
      bat_v REAL,
      payload_b64 TEXT,
      f_port INTEGER,
      f_cnt INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chameleon_readings_deveui_time
      ON chameleon_readings(deveui, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_chameleon_readings_array_id
      ON chameleon_readings(array_id);
  "
done
```

- [ ] **Step 2: Verify schema exists in every seed**

Run:

```bash
for db in \
  database/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  web/react-gui/farming.db
do
  echo "$db"
  sqlite3 "$db" ".schema chameleon_readings" | grep -E "CREATE TABLE|idx_chameleon"
done
```

Expected: each DB prints the table and both indexes.

- [ ] **Step 3: Commit seed DBs**

```bash
git add database/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        web/react-gui/farming.db
git commit -m "db(chameleon): add chameleon readings table to seed databases"
```

---

## Task 7: Extend Verification Coverage

**Files:**
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-lsn50-chameleon-codec.js`
- Test: verification scripts.

- [ ] **Step 1: Add `verify-sync-flow.js` assertions**

Add `Insert Chameleon Reading` to the `requiredFunctionNodes` list so the normal flow verifier compiles the new function node with the rest of the Node-RED function nodes:

```js
  'Insert Chameleon Reading',
```

Add this helper next to `readTableColumns`:

```js
function readTableIndexes(dbPath, tableName) {
  const output = execFileSync('sqlite3', [dbPath, `pragma index_list(${tableName});`], { encoding: 'utf8' });
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|');
      return parts[1];
    })
    .filter(Boolean);
}
```

Add assertions near the existing LSN50/dendrometer schema checks:

```js
expectIncludes('Sync Init Schema + Triggers', 'CREATE TABLE IF NOT EXISTS chameleon_readings', 'creates local Chameleon readings table');
expectIncludes('Sync Init Schema + Triggers', 'idx_chameleon_readings_deveui_time', 'indexes Chameleon readings by device and time');
expectIncludes('Sync Init Schema + Triggers', 'idx_chameleon_readings_array_id', 'indexes Chameleon readings by array id');
expectIncludes('Decode LSN50', 'chameleonPayloadVersion', 'normalizes Chameleon payload version from decoder output');
expectIncludes('Apply Config', '} else if (d.isChameleon === true) {', 'adds a dedicated Chameleon branch before dendrometer derivation');
expectIncludes('Apply Config', 'd.dendroValid = null', 'sets dendrometer validity null for Chameleon payloads');
expectIncludes('Apply Config', 'Chameleon flags 0x', 'surfaces Chameleon status in node status text');
expectIncludes('Insert Chameleon Reading', 'INSERT INTO chameleon_readings', 'persists decoded Chameleon readings locally');
expectIncludes('Insert Chameleon Reading', 'if (!d || d.isChameleon !== true) return msg;', 'passes non-Chameleon LSN50 payloads downstream');
expectIncludes('Build Dendrometer Readings INSERT', 'd.isChameleon === true', 'defensively skips dendrometer readings for Chameleon payloads');
expectLibById('chameleon-readings-insert-fn', 'osiDb', 'osi-db-helper', 'imports osi-db-helper in Insert Chameleon Reading');
expectWireById('lsn50-zone-agg-fn', 'chameleon-readings-insert-fn', 'routes LSN50 flow through Chameleon insert');
expectWireById('chameleon-readings-insert-fn', 'dendro-readings-insert-fn', 'passes Chameleon insert output to dendrometer insert');
```

Also iterate the existing `seedDatabasePaths` list and assert every bundled seed contains the new table columns and indexes:

```js
for (const seedDatabasePath of seedDatabasePaths) {
  const seedName = path.relative(path.resolve(__dirname, '..'), seedDatabasePath);
  const columns = new Set(readTableColumns(seedDatabasePath, 'chameleon_readings'));
  const indexes = new Set(readTableIndexes(seedDatabasePath, 'chameleon_readings'));
  expectCondition(columns.has('payload_b64'), `${seedName} has chameleon_readings.payload_b64`);
  expectCondition(columns.has('r1_ohm_comp'), `${seedName} has chameleon_readings.r1_ohm_comp`);
  expectCondition(columns.has('f_cnt'), `${seedName} has chameleon_readings.f_cnt`);
  expectCondition(indexes.has('idx_chameleon_readings_deveui_time'), `${seedName} has idx_chameleon_readings_deveui_time`);
  expectCondition(indexes.has('idx_chameleon_readings_array_id'), `${seedName} has idx_chameleon_readings_array_id`);
}
```

Use `seedDatabasePaths` directly so the bcm2708 and bcm2709 images stay covered.

- [ ] **Step 2: Add dry-connected decoder fixture**

In `scripts/verify-lsn50-chameleon-codec.js`, add a fixture based on `chameleonFrame` that sets raw values to `9999999` and keeps status flags `0`:

```js
const dryConnectedFrame = chameleonFrame.slice();
dryConnectedFrame[9] = 0x00;
dryConnectedFrame.splice(24, 4, 0x00, 0x98, 0x96, 0x7f); // 9999999
dryConnectedFrame.splice(28, 4, 0x00, 0x98, 0x96, 0x7f);
dryConnectedFrame.splice(32, 4, 0x00, 0x98, 0x96, 0x7f);
const dryConnected = decode(dryConnectedFrame);
assert.strictEqual(dryConnected.Chameleon_CH1_Open, false);
assert.strictEqual(dryConnected.Chameleon_CH2_Open, false);
assert.strictEqual(dryConnected.Chameleon_CH3_Open, false);
assert.strictEqual(dryConnected.Chameleon_R1_Ohm_Raw, 9999999);
assert.strictEqual(dryConnected.Chameleon_R2_Ohm_Raw, 9999999);
assert.strictEqual(dryConnected.Chameleon_R3_Ohm_Raw, 9999999);
```

Run this against the current decoder before changing persistence. If decoder sentinel semantics change later, update persistence policy and this fixture together. For current firmware, `9999999` is dry/saturation data and must remain numeric when flags are clear.

- [ ] **Step 3: Run verification**

```bash
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-sync-flow.js
scripts/check-mqtt-topics.sh
```

Expected:
- `LSN50 Chameleon codec checks passed`
- `LSN50 Chameleon persistence checks passed`
- `All sync flow checks passed`
- MQTT topic check exits `0`

- [ ] **Step 4: Commit verification updates**

```bash
git add scripts/verify-sync-flow.js scripts/verify-lsn50-chameleon-codec.js
git commit -m "test(chameleon): cover readings persistence and dry saturation"
```

---

## Task 8: Final Review

**Files:** all changed files.

- [ ] **Step 1: Review diffs**

Run:

```bash
git diff --stat HEAD~7..HEAD
git diff HEAD~7..HEAD -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json scripts/verify-lsn50-chameleon-persistence.js scripts/verify-sync-flow.js scripts/verify-lsn50-chameleon-codec.js
```

Check:
- Chameleon table is local-only; no cloud outbox trigger was added.
- Chameleon frames still insert the generic LSN50 `device_data` row.
- Chameleon frames insert exactly one `chameleon_readings` row.
- Non-Chameleon LSN50 frames still pass through to dendrometer insertion.
- Chameleon frames do not produce `dendrometer_readings`.
- Dry connected raw `9999999` values remain numeric if open flags are false.

- [ ] **Step 2: Run final verification**

```bash
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-sync-flow.js
scripts/check-mqtt-topics.sh
git status --short --branch
```

Expected: all scripts pass; working tree contains only intentional changes or is clean after commits.

- [ ] **Step 3: Prepare deployment note**

Record this rollout note in the final response:

```text
Live Pi deploy must preserve /data/db/farming.db. The Node-RED sync-init flow creates chameleon_readings idempotently on startup; do not replace the live DB file.
```

---

## Open Follow-Ups

- kPa conversion table columns and coefficient storage.
- GUI/API exposure of latest Chameleon readings.
- OSI Server/cloud sync contract for `chameleon_readings`.
- Device typing beyond `DRAGINO_LSN50` if Chameleon becomes a first-class product variant.
- Add a `(deveui, f_cnt)` deduplication policy once ChirpStack event shape and frame-counter reliability are confirmed across deployed versions.
- Investigate firmware-side raw resistance saturation at exactly `9999999` on dry connected sensors; keep it separate from the persistence task unless the codec sentinel contract changes.
