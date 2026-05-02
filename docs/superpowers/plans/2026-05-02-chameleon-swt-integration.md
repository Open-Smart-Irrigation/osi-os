# Chameleon SWT Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Convert VIA Chameleon resistance payloads from Dragino LSN50 MOD3 uplinks into calibrated SWT/kPa readings on the edge and expose Chameleon enablement, depths, and calibration values in the LSN50 card.

**Architecture:** Keep `chameleon_readings` as the raw decoded payload table and store calibrated SWT readings in `device_data.swt_1`, `device_data.swt_2`, and `device_data.swt_3` so existing history and schedule paths can consume them. Add a focused `osi-chameleon-helper` package for the resistance-to-kPa formula, and refactor the LSN50 flow so Chameleon SWT derivation and dendrometer derivation are independent optional layers on the same MOD3 uplink. Extend the React LSN50 card with a dedicated Chameleon settings section while keeping dendrometer and Chameleon enable flags independent.

**Tech Stack:** Node-RED function nodes in `flows.json`, local SQLite schema migrations and bundled seed DBs, local Node helper packages, React/Vite TypeScript GUI, Node verification scripts.

---

## Decisions And Constraints

- Formula source: `/home/phil/kDrive/OSI OS/Hardware/Chameleon/conversion resistance tension.xlsx` documents `x = Resistance (kOhms)`, `y = Tension (kPa)`, and `y = a * ln(x) + b * x + c`.
- Default calibration values come from the workbook row referenced by the current workbook formulas:
  - SWT1: `a=10.71`, `b=0.13`, `c=7.18`
  - SWT2: `a=10.40`, `b=0.13`, `c=7.31`
  - SWT3: `a=10.33`, `b=0.12`, `c=7.21`
- These defaults are only fallback values for an uncalibrated device. Per-device / array-specific calibration values stored in `devices.chameleon_swt{1,2,3}_{a,b,c}` override the defaults as soon as they are saved from the Chameleon settings section. A future array-ID calibration catalog can populate the same columns without changing the conversion path.
- Use compensated resistance (`Chameleon_R*_Ohm_Comp`) for SWT conversion. Raw resistance remains stored in `chameleon_readings` for diagnostics.
- Treat `I2C_MISSING` and `TIMEOUT` as data-invalid for all three SWT channels. Treat per-channel open flags as invalid only for that channel.
- Preserve the dry-connected edge case: raw values at `9999999` ohm are not an open-circuit sentinel. Only the firmware's explicit `10000000` sentinel/open flag nulls a channel.
- Clamp derived SWT to `0..300` kPa to match existing schedule validation; store values rounded to two decimals.
- `chameleon_enabled` controls SWT derivation and display. It does not suppress raw `chameleon_readings` insertion.
- `dendro_enabled` controls ADC/dendrometer derivation and display. ADC values may remain in `device_data` for audit/debugging, but the GUI must not show a generic ADC card when `dendro_enabled=0`.
- Chameleon and dendrometer can both be enabled. In that mode, one MOD3 uplink stores raw Chameleon readings, derived Chameleon SWT, and derived dendrometer values.
- No OSI Server GUI or Node-RED cloud UI changes are part of this plan. Edge sync/export changes are limited to preserving local schema compatibility.

## Implementation Notes

- Executed on branch `feature/chameleon-swt-integration` with subagent-driven implementation, per-task spec review, and per-task code-quality review.
- The focused verifier uses the repo-local SQLite dependency pattern and covers helper math, schema, deploy repair, flow wiring, UI contract, bundled DBs, and live Chameleon field samples.
- Live deploy repair now verifies the Chameleon columns after applying idempotent `ALTER TABLE` statements. It does not overwrite `/data/db/farming.db`.
- All six seed DBs listed by `scripts/verify-sync-flow.js` were patched, including the `bcm2708` and `bcm2709` full images.
- Chameleon config is local-edge configuration in this iteration. The local API updates `devices.updated_at`, but does not increment sync metadata or add OSI Server control-plane fields.
- `GET /api/devices` uses canonical uppercase 16-hex DevEUI filtering and a deterministic latest-Chameleon anti-join with timestamp plus `id` tie-break.
- When no valid DevEUIs exist in the latest-data query, the function emits a no-row SQL statement instead of returning an incomplete message.
- Chameleon raw readings continue to be inserted even when `chameleon_enabled=0`; derived `swt_1/2/3` stay null unless Chameleon SWT is enabled.
- Dendrometer and Chameleon are independent layers on MOD3. Chameleon no longer bypasses dendrometer derivation or dendrometer reading insertion.
- The GUI treats workbook coefficients as placeholders until explicitly restored or saved. Blank saved values remain blank in the settings form.
- The LSN50 card renders a dedicated Chameleon SWT section only when `chameleon_enabled=1`, suppresses invalid samples on I2C missing/timeout, and removes the old generic ADC card when dendrometer is disabled.

## File Structure

- Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/package.json`: local Node-RED helper package manifest.
- Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`: pure Chameleon calibration and derivation functions.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json` and `package-lock.json`: register `osi-chameleon-helper`.
- Modify `deploy.sh`: deploy the helper package and add live schema repair for Chameleon SWT columns.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`: schema migration, LSN50 config query, apply-config derivation, SQL insert, API endpoints, GET devices merge, history fields, scheduler SWT query, and dendrometer insert guard.
- Modify six bundled seed DB files listed by `scripts/verify-sync-flow.js`: add Chameleon config columns to `devices` and `swt_1/swt_2/swt_3` to `device_data`.
- Create `scripts/verify-lsn50-chameleon-swt.js`: focused backend verifier for formula, flow wiring, coexistence, schema, and deploy coverage.
- Modify `scripts/verify-lsn50-chameleon-persistence.js`: update assertions that currently expect Chameleon to close the dendrometer path.
- Modify `scripts/verify-sync-flow.js`: add broad schema/API/UI assertions and update previous Chameleon branch assertions.
- Modify `web/react-gui/src/types/farming.ts`: type Chameleon config and latest SWT/status fields.
- Modify `web/react-gui/src/services/api.ts`: add Chameleon API helpers and normalize new fields.
- Create `web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx`: settings section for Chameleon depths and calibration coefficients.
- Modify `web/react-gui/src/components/farming/DraginoSettingsModal.tsx`: add Chameleon enable toggle, MOD3 guard, and dedicated settings section.
- Modify `web/react-gui/src/components/farming/DraginoTempCard.tsx`: render SWT1/SWT2/SWT3 cards and remove generic ADC display while dendrometer is disabled.

## Task 1: Failing Backend Verifier

**Files:**
- Create: `scripts/verify-lsn50-chameleon-swt.js`

- [x] **Step 1: Write the failing verifier**

Create `scripts/verify-lsn50-chameleon-swt.js`:

```js
#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sqlite3 = require('sqlite3');

const repoRoot = path.resolve(__dirname, '..');
const flowPath = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const nodeRedRoot = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const helperPath = path.join(nodeRedRoot, 'osi-chameleon-helper/index.js');
const packageJsonPath = path.join(nodeRedRoot, 'package.json');
const deployPath = path.join(repoRoot, 'deploy.sh');
const flows = JSON.parse(fs.readFileSync(flowPath, 'utf8'));

const seedDatabasePaths = [
  'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'database/farming.db',
  'web/react-gui/farming.db',
].map((relativePath) => path.join(repoRoot, relativePath));

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

function assertExcludes(haystack, needle, label) {
  assert(!haystack.includes(needle), `${label}: did not expect to find ${needle}`);
}

function assertLibById(id, variableName, moduleName) {
  const libs = nodeById(id).libs || [];
  assert(
    libs.some((entry) => entry.var === variableName && entry.module === moduleName),
    `${id} must import ${moduleName} as ${variableName}`,
  );
}

function compileFunctionNode(id) {
  new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${funcOf(id)}\n})`);
}

function tableColumns(dbPath, tableName) {
  const db = new sqlite3.Database(dbPath);
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${tableName})`, (error, rows) => {
      db.close(() => {});
      if (error) reject(error);
      else resolve(new Set((rows || []).map((row) => row.name)));
    });
  });
}

(async () => {
  assert(fs.existsSync(helperPath), 'osi-chameleon-helper/index.js exists');
  const chameleon = require(helperPath);
  assert.strictEqual(typeof chameleon.resistanceOhmsToKpa, 'function', 'helper exports resistanceOhmsToKpa');
  assert.strictEqual(typeof chameleon.buildChameleonSwtMetrics, 'function', 'helper exports buildChameleonSwtMetrics');

  assert.strictEqual(chameleon.resistanceOhmsToKpa(1168, { a: 10.71, b: 0.13, c: 7.18 }), 9.00);
  assert.strictEqual(chameleon.resistanceOhmsToKpa(10257, { a: 10.40, b: 0.13, c: 7.31 }), 32.85);
  assert.strictEqual(chameleon.resistanceOhmsToKpa(101195, { a: 10.33, b: 0.12, c: 7.21 }), 67.05);
  assert.strictEqual(chameleon.resistanceOhmsToKpa(162580, { a: 10.71, b: 0.13, c: 7.18 }), 82.84);
  assert.strictEqual(chameleon.resistanceOhmsToKpa(10000000, { a: 10.71, b: 0.13, c: 7.18 }), null);

  const sample = {
    r1OhmComp: 874,
    r2OhmComp: 836,
    r3OhmComp: 882,
    i2cMissing: 0,
    timeout: 0,
    ch1Open: 0,
    ch2Open: 0,
    ch3Open: 0,
  };
  const metrics = chameleon.buildChameleonSwtMetrics(sample, { enabled: 1 });
  assert.deepStrictEqual(
    { swt1Kpa: metrics.swt1Kpa, swt2Kpa: metrics.swt2Kpa, swt3Kpa: metrics.swt3Kpa },
    { swt1Kpa: 5.85, swt2Kpa: 5.56, swt3Kpa: 6.02 },
  );
  assert.strictEqual(chameleon.buildChameleonSwtMetrics(sample, { enabled: 0 }).swt1Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, timeout: 1 }, { enabled: 1 }).swt2Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, ch2Open: 1 }, { enabled: 1 }).swt2Kpa, null);
  assert.strictEqual(chameleon.buildChameleonSwtMetrics({ ...sample, r1OhmComp: 9999999 }, { enabled: 1 }).swt1Kpa, 300);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.strictEqual(packageJson.dependencies['osi-chameleon-helper'], 'file:osi-chameleon-helper');

  const deploy = fs.readFileSync(deployPath, 'utf8');
  assertIncludes(deploy, 'osi-chameleon-helper/package.json', 'deploy ships Chameleon helper package manifest');
  assertIncludes(deploy, 'osi-chameleon-helper/index.js', 'deploy ships Chameleon helper implementation');
  assertIncludes(deploy, 'ensure_chameleon_schema', 'deploy repairs live Chameleon SWT schema');

  assertLibById('lsn50-apply-config', 'chameleon', 'osi-chameleon-helper');
  assertIncludes(funcOf('lsn50-config-query-fn'), 'chameleon_enabled', 'LSN50 config query loads Chameleon enable flag');
  assertIncludes(funcOf('lsn50-config-query-fn'), 'chameleon_swt1_a', 'LSN50 config query loads Chameleon coefficients');
  assertIncludes(funcOf('lsn50-apply-config'), 'chameleon.buildChameleonSwtMetrics', 'Apply Config derives Chameleon SWT');
  assertIncludes(funcOf('lsn50-apply-config'), 'd.swt1Kpa = swt.swt1Kpa;', 'Apply Config stores SWT1 in formattedData');
  assertIncludes(funcOf('lsn50-apply-config'), 'if (!dendroEnabled)', 'Apply Config still gates dendrometer by dendro_enabled');
  assertExcludes(funcOf('lsn50-apply-config'), '} else if (d.isChameleon === true) {', 'Chameleon no longer bypasses dendrometer derivation');
  assertExcludes(funcOf('dendro-readings-insert-fn'), 'd.isChameleon === true', 'Dendrometer insert no longer skips Chameleon frames by type');

  assertIncludes(funcOf('lsn50-sql-fn'), 'swt_1, swt_2, swt_3', 'device_data insert stores canonical SWT channels');
  assertIncludes(funcOf('format-devices'), 'dd.swt_1', 'GET /api/devices selects SWT1');
  assertIncludes(funcOf('merge-device-data'), 'chameleon_enabled: d.chameleon_enabled ?? 0', 'GET /api/devices returns Chameleon enable flag');
  assertIncludes(funcOf('sensor-history-fn'), "'swt_1'", 'sensor history allows SWT1');
  assertIncludes(funcOf('sensor-history-fn'), "'swt_2'", 'sensor history allows SWT2');
  assertIncludes(funcOf('sensor-history-fn'), "'swt_3'", 'sensor history allows SWT3');
  assertIncludes(funcOf('d0b2b1c1a937e16d'), "ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1", 'scheduler includes Chameleon-enabled LSN50 SWT');
  assertIncludes(funcOf('d0b2b1c1a937e16d'), 'COALESCE(dd.swt_3, NULL)', 'SWT_AVG expression handles SWT3');

  compileFunctionNode('lsn50-config-query-fn');
  compileFunctionNode('lsn50-apply-config');
  compileFunctionNode('lsn50-sql-fn');
  compileFunctionNode('dendro-readings-insert-fn');
  compileFunctionNode('put-chameleon-config-auth-fn');

  for (const dbPath of seedDatabasePaths) {
    const devices = await tableColumns(dbPath, 'devices');
    const deviceData = await tableColumns(dbPath, 'device_data');
    for (const column of [
      'chameleon_enabled',
      'chameleon_swt1_depth_cm',
      'chameleon_swt2_depth_cm',
      'chameleon_swt3_depth_cm',
      'chameleon_swt1_a',
      'chameleon_swt1_b',
      'chameleon_swt1_c',
      'chameleon_swt2_a',
      'chameleon_swt2_b',
      'chameleon_swt2_c',
      'chameleon_swt3_a',
      'chameleon_swt3_b',
      'chameleon_swt3_c',
    ]) {
      assert(devices.has(column), `${path.relative(repoRoot, dbPath)} devices table has ${column}`);
    }
    for (const column of ['swt_1', 'swt_2', 'swt_3']) {
      assert(deviceData.has(column), `${path.relative(repoRoot, dbPath)} device_data table has ${column}`);
    }
  }

  console.log('LSN50 Chameleon SWT checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [x] **Step 2: Run the verifier to confirm it fails**

Run:

```bash
node scripts/verify-lsn50-chameleon-swt.js
```

Expected: FAIL because `osi-chameleon-helper/index.js` does not exist.

- [x] **Step 3: Commit the failing verifier**

```bash
git add scripts/verify-lsn50-chameleon-swt.js
git commit -m "test: add chameleon swt integration verifier"
```

## Task 2: Chameleon Formula Helper

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/package.json`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json`

- [x] **Step 1: Add the helper package manifest**

Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/package.json`:

```json
{
  "name": "osi-chameleon-helper",
  "version": "1.0.0",
  "main": "index.js",
  "license": "UNLICENSED"
}
```

- [x] **Step 2: Add the helper implementation**

Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js`:

```js
'use strict';

const MAX_VALID_RESISTANCE_OHMS = 10000000;
const MIN_KPA = 0;
const MAX_KPA = 300;

const DEFAULT_CALIBRATION = Object.freeze({
  swt1: Object.freeze({ a: 10.71, b: 0.13, c: 7.18 }),
  swt2: Object.freeze({ a: 10.40, b: 0.13, c: 7.31 }),
  swt3: Object.freeze({ a: 10.33, b: 0.12, c: 7.21 }),
});

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toFlag(value) {
  return Number(value || 0) === 1;
}

function roundTo(value, decimals) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const factor = Math.pow(10, Number(decimals) || 0);
  return Math.round(number * factor) / factor;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(value, min), max);
}

function normalizeCoefficients(input, fallback) {
  const a = toFiniteNumber(input && input.a);
  const b = toFiniteNumber(input && input.b);
  const c = toFiniteNumber(input && input.c);
  return {
    a: a === null ? fallback.a : a,
    b: b === null ? fallback.b : b,
    c: c === null ? fallback.c : c,
  };
}

function calibrationFromDeviceRow(row = {}) {
  return {
    enabled: Number(row.chameleon_enabled || 0) === 1 ? 1 : 0,
    swt1: normalizeCoefficients(
      { a: row.chameleon_swt1_a, b: row.chameleon_swt1_b, c: row.chameleon_swt1_c },
      DEFAULT_CALIBRATION.swt1,
    ),
    swt2: normalizeCoefficients(
      { a: row.chameleon_swt2_a, b: row.chameleon_swt2_b, c: row.chameleon_swt2_c },
      DEFAULT_CALIBRATION.swt2,
    ),
    swt3: normalizeCoefficients(
      { a: row.chameleon_swt3_a, b: row.chameleon_swt3_b, c: row.chameleon_swt3_c },
      DEFAULT_CALIBRATION.swt3,
    ),
  };
}

function resistanceOhmsToKpa(ohms, coefficients) {
  const resistanceOhms = toFiniteNumber(ohms);
  const coeffs = normalizeCoefficients(coefficients || {}, DEFAULT_CALIBRATION.swt1);
  if (resistanceOhms === null || resistanceOhms <= 0 || resistanceOhms >= MAX_VALID_RESISTANCE_OHMS) {
    return null;
  }
  const resistanceKOhms = resistanceOhms / 1000;
  const kpa = coeffs.a * Math.log(resistanceKOhms) + coeffs.b * resistanceKOhms + coeffs.c;
  if (!Number.isFinite(kpa)) return null;
  return roundTo(clamp(kpa, MIN_KPA, MAX_KPA), 2);
}

function buildChameleonSwtMetrics(sample = {}, config = {}) {
  const calibration = {
    enabled: Number(config.enabled || 0) === 1 ? 1 : 0,
    swt1: normalizeCoefficients(config.swt1 || {}, DEFAULT_CALIBRATION.swt1),
    swt2: normalizeCoefficients(config.swt2 || {}, DEFAULT_CALIBRATION.swt2),
    swt3: normalizeCoefficients(config.swt3 || {}, DEFAULT_CALIBRATION.swt3),
  };
  const dataInvalid = toFlag(sample.i2cMissing) || toFlag(sample.timeout);
  const enabled = calibration.enabled === 1;
  return {
    enabled,
    dataInvalid,
    swt1Kpa: enabled && !dataInvalid && !toFlag(sample.ch1Open)
      ? resistanceOhmsToKpa(sample.r1OhmComp, calibration.swt1)
      : null,
    swt2Kpa: enabled && !dataInvalid && !toFlag(sample.ch2Open)
      ? resistanceOhmsToKpa(sample.r2OhmComp, calibration.swt2)
      : null,
    swt3Kpa: enabled && !dataInvalid && !toFlag(sample.ch3Open)
      ? resistanceOhmsToKpa(sample.r3OhmComp, calibration.swt3)
      : null,
  };
}

module.exports = {
  DEFAULT_CALIBRATION,
  MAX_VALID_RESISTANCE_OHMS,
  calibrationFromDeviceRow,
  resistanceOhmsToKpa,
  buildChameleonSwtMetrics,
  toFiniteNumber,
};
```

- [x] **Step 3: Register the helper dependency**

Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json` so `dependencies` includes:

```json
"osi-chameleon-helper": "file:osi-chameleon-helper"
```

Keep the existing dependencies unchanged.

- [x] **Step 4: Update the lockfile**

Run:

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` includes `osi-chameleon-helper`.

- [x] **Step 5: Run the focused verifier**

Run:

```bash
node scripts/verify-lsn50-chameleon-swt.js
```

Expected: still FAIL, now on flow/schema assertions.

- [x] **Step 6: Commit the helper**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper
git commit -m "feat: add chameleon swt calibration helper"
```

## Task 3: SQLite Schema And Deploy Repair

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: six bundled `farming.db` files listed in Task 1
- Modify: `deploy.sh`

- [x] **Step 1: Add sync-init schema migrations**

In `sync-init-fn`, add these statements next to the existing `devices` and `device_data` column migrations:

```js
"ALTER TABLE devices ADD COLUMN chameleon_enabled INTEGER DEFAULT 0",
"ALTER TABLE devices ADD COLUMN chameleon_swt1_depth_cm REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt2_depth_cm REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt3_depth_cm REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt1_a REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt1_b REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt1_c REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt2_a REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt2_b REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt2_c REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt3_a REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt3_b REAL",
"ALTER TABLE devices ADD COLUMN chameleon_swt3_c REAL",
"UPDATE devices SET chameleon_enabled = 0 WHERE chameleon_enabled IS NULL",
"ALTER TABLE device_data ADD COLUMN swt_1 REAL",
"ALTER TABLE device_data ADD COLUMN swt_2 REAL",
"ALTER TABLE device_data ADD COLUMN swt_3 REAL",
```

- [x] **Step 2: Preserve Chameleon columns in any devices table rebuild**

In the `sync-init-fn` `CREATE TABLE devices_new` statement, add:

```sql
chameleon_enabled INTEGER DEFAULT 0,
chameleon_swt1_depth_cm REAL,
chameleon_swt2_depth_cm REAL,
chameleon_swt3_depth_cm REAL,
chameleon_swt1_a REAL,
chameleon_swt1_b REAL,
chameleon_swt1_c REAL,
chameleon_swt2_a REAL,
chameleon_swt2_b REAL,
chameleon_swt2_c REAL,
chameleon_swt3_a REAL,
chameleon_swt3_b REAL,
chameleon_swt3_c REAL
```

In the matching `INSERT INTO devices_new` / `SELECT FROM devices` statement, copy the columns as:

```sql
COALESCE(chameleon_enabled,0),
chameleon_swt1_depth_cm,
chameleon_swt2_depth_cm,
chameleon_swt3_depth_cm,
chameleon_swt1_a,
chameleon_swt1_b,
chameleon_swt1_c,
chameleon_swt2_a,
chameleon_swt2_b,
chameleon_swt2_c,
chameleon_swt3_a,
chameleon_swt3_b,
chameleon_swt3_c
```

- [x] **Step 3: Patch all bundled seed DB files**

Run this one-off script from the repo root:

```bash
node <<'NODE'
const sqlite3 = require('sqlite3');
const paths = [
  'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'database/farming.db',
  'web/react-gui/farming.db',
];
const statements = [
  'ALTER TABLE devices ADD COLUMN chameleon_enabled INTEGER DEFAULT 0',
  'ALTER TABLE devices ADD COLUMN chameleon_swt1_depth_cm REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt2_depth_cm REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt3_depth_cm REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt1_a REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt1_b REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt1_c REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt2_a REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt2_b REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt2_c REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt3_a REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt3_b REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt3_c REAL',
  'UPDATE devices SET chameleon_enabled = 0 WHERE chameleon_enabled IS NULL',
  'ALTER TABLE device_data ADD COLUMN swt_1 REAL',
  'ALTER TABLE device_data ADD COLUMN swt_2 REAL',
  'ALTER TABLE device_data ADD COLUMN swt_3 REAL',
];
function run(db, sql) {
  return new Promise((resolve, reject) => db.run(sql, (error) => {
    if (error && !/duplicate column name/i.test(String(error.message || error))) reject(error);
    else resolve();
  }));
}
(async () => {
  for (const dbPath of paths) {
    const db = new sqlite3.Database(dbPath);
    for (const sql of statements) await run(db, sql);
    await new Promise((resolve, reject) => db.get('PRAGMA integrity_check', (error, row) => {
      if (error) reject(error);
      else if (!row || row.integrity_check !== 'ok') reject(new Error(`${dbPath} integrity_check failed`));
      else resolve();
    }));
    await new Promise((resolve) => db.close(resolve));
    console.log(`patched ${dbPath}`);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
```

Expected: each seed DB prints one line per file, for example `patched database/farming.db`, and no integrity error.

- [x] **Step 4: Add live deploy schema repair and helper deployment**

In `deploy.sh`, add `ensure_chameleon_schema()` after `ensure_dendro_schema()`:

```sh
ensure_chameleon_schema() {
    echo "--- Live Chameleon SWT schema repair ---"
    if [ ! -e "$DB_PATH" ]; then
        echo "SKIP: no live database at $DB_PATH"
        return 0
    fi
    node <<'NODE'
const fs = require('fs');
const dbPath = '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
  console.log('SKIP: no live database at ' + dbPath);
  process.exit(0);
}
const sqlite3 = require('/srv/node-red/node_modules/sqlite3');
const db = new sqlite3.Database(dbPath);
const stmts = [
  'ALTER TABLE devices ADD COLUMN chameleon_enabled INTEGER DEFAULT 0',
  'ALTER TABLE devices ADD COLUMN chameleon_swt1_depth_cm REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt2_depth_cm REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt3_depth_cm REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt1_a REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt1_b REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt1_c REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt2_a REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt2_b REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt2_c REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt3_a REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt3_b REAL',
  'ALTER TABLE devices ADD COLUMN chameleon_swt3_c REAL',
  'UPDATE devices SET chameleon_enabled = 0 WHERE chameleon_enabled IS NULL',
  'ALTER TABLE device_data ADD COLUMN swt_1 REAL',
  'ALTER TABLE device_data ADD COLUMN swt_2 REAL',
  'ALTER TABLE device_data ADD COLUMN swt_3 REAL',
];
function run(sql) {
  return new Promise((resolve, reject) => db.run(sql, (err) => {
    if (err && !/duplicate column name/i.test(String(err && err.message || err))) reject(err);
    else resolve();
  }));
}
function columns(table) {
  return new Promise((resolve, reject) => db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err) reject(err);
    else resolve(new Set((rows || []).map((row) => row.name)));
  }));
}
(async () => {
  await run('PRAGMA busy_timeout=5000');
  for (const sql of stmts) await run(sql);
  const deviceColumns = await columns('devices');
  const dataColumns = await columns('device_data');
  for (const column of ['chameleon_enabled', 'chameleon_swt1_a', 'chameleon_swt2_a', 'chameleon_swt3_a']) {
    if (!deviceColumns.has(column)) throw new Error('missing devices.' + column);
  }
  for (const column of ['swt_1', 'swt_2', 'swt_3']) {
    if (!dataColumns.has(column)) throw new Error('missing device_data.' + column);
  }
  console.log('OK');
  db.close();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  db.close();
  process.exit(1);
});
NODE
}
```

Call it after `ensure_dendro_schema`:

```sh
ensure_dendro_schema
ensure_chameleon_schema
```

Add helper fetch steps next to the dendro helper fetches:

```sh
fetch_required "osi-chameleon-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/package.json" \
    "/srv/node-red/osi-chameleon-helper/package.json"

fetch_required "osi-chameleon-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js" \
    "/srv/node-red/osi-chameleon-helper/index.js"
```

- [x] **Step 5: Run schema verification**

Run:

```bash
node scripts/verify-lsn50-chameleon-swt.js
node scripts/verify-sync-flow.js
```

Expected: `verify-lsn50-chameleon-swt.js` still FAILS on flow/API assertions; `verify-sync-flow.js` may still FAIL until Task 5 updates old Chameleon expectations.

- [x] **Step 6: Commit schema and deploy changes**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        database/farming.db \
        web/react-gui/farming.db \
        deploy.sh
git commit -m "feat: add chameleon swt schema"
```

## Task 4: LSN50 Backend Derivation And Persistence

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `scripts/verify-lsn50-chameleon-persistence.js`
- Modify: `scripts/verify-sync-flow.js`

- [x] **Step 1: Load Chameleon config in the LSN50 config query**

Replace `lsn50-config-query-fn` query with:

```js
const devEui = msg.formattedData && msg.formattedData.devEui;
if (!devEui) { node.error('no devEui in formattedData'); return null; }
msg.topic = [
  'SELECT dendro_enabled, temp_enabled, COALESCE(device_mode, 1) AS device_mode,',
  '       COALESCE(chameleon_enabled, 0) AS chameleon_enabled,',
  '       chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm,',
  '       chameleon_swt1_a, chameleon_swt1_b, chameleon_swt1_c,',
  '       chameleon_swt2_a, chameleon_swt2_b, chameleon_swt2_c,',
  '       chameleon_swt3_a, chameleon_swt3_b, chameleon_swt3_c,',
  '       COALESCE(dendro_force_legacy, 0) AS dendro_force_legacy,',
  '       dendro_stroke_mm, dendro_ratio_at_retracted, dendro_ratio_at_extended,',
  '       dendro_ratio_zero, dendro_ratio_span, COALESCE(dendro_invert_direction, 0) AS dendro_invert_direction,',
  '       dendro_baseline_position_mm, dendro_baseline_mode_used, dendro_baseline_calibration_signature',
  'FROM devices',
  "WHERE deveui = '" + String(devEui).replace(/'/g, "''") + "'",
  'LIMIT 1'
].join(' ');
return msg;
```

- [x] **Step 2: Import `osi-chameleon-helper` in `lsn50-apply-config`**

Add this entry to the node's `libs` array:

```json
{ "var": "chameleon", "module": "osi-chameleon-helper" }
```

Keep the existing `osiDb` and `osi-dendro-helper` libs.

- [x] **Step 3: Replace the Chameleon bypass branch with independent derivation**

Remove the entire `} else if (d.isChameleon === true) {` branch that clears dendrometer state. In the non-MOD9 branch, run Chameleon derivation before the existing `if (!tempEnabled)` and `if (!dendroEnabled)` blocks:

```js
    d.modeCodeToStore = d.observedModeCode != null ? d.observedModeCode : effectiveMode;
    d.modeLabelToStore = d.observedModeLabel != null ? d.observedModeLabel : dendro.lsn50ModeLabel(effectiveMode);
    if (!d.observedModeObservedAt && d.observedModeCode != null) {
        d.observedModeObservedAt = d.timestamp;
    }

    d.swt1Kpa = null;
    d.swt2Kpa = null;
    d.swt3Kpa = null;
    if (d.isChameleon === true) {
        const swt = chameleon.buildChameleonSwtMetrics({
            r1OhmComp: d.chameleonR1OhmComp,
            r2OhmComp: d.chameleonR2OhmComp,
            r3OhmComp: d.chameleonR3OhmComp,
            i2cMissing: d.chameleonI2cMissing,
            timeout: d.chameleonTimeout,
            ch1Open: d.chameleonCh1Open,
            ch2Open: d.chameleonCh2Open,
            ch3Open: d.chameleonCh3Open
        }, {
            enabled: row && row.chameleon_enabled,
            swt1: { a: row && row.chameleon_swt1_a, b: row && row.chameleon_swt1_b, c: row && row.chameleon_swt1_c },
            swt2: { a: row && row.chameleon_swt2_a, b: row && row.chameleon_swt2_b, c: row && row.chameleon_swt2_c },
            swt3: { a: row && row.chameleon_swt3_a, b: row && row.chameleon_swt3_b, c: row && row.chameleon_swt3_c }
        });
        d.swt1Kpa = swt.swt1Kpa;
        d.swt2Kpa = swt.swt2Kpa;
        d.swt3Kpa = swt.swt3Kpa;
    }

    if (!tempEnabled) {
        d.tempC1 = null;
    }
```

Keep the existing dendrometer block after this code. This lets `dendro_enabled=1` compute dendrometer values from `adcV/adcCh1V` on the same Chameleon MOD3 uplink.

- [x] **Step 4: Update Chameleon node status without bypassing dendrometer**

Inside the same non-MOD9 branch, after Chameleon derivation and after dendrometer derivation, set status with both layers:

```js
        const chameleonParts = [];
        if (d.isChameleon === true) {
            if (d.chameleonStatusFlags != null) chameleonParts.push('Chameleon flags 0x' + Number(d.chameleonStatusFlags).toString(16).toUpperCase());
            if (d.swt1Kpa != null) chameleonParts.push('SWT1 ' + d.swt1Kpa + ' kPa');
            if (d.swt2Kpa != null) chameleonParts.push('SWT2 ' + d.swt2Kpa + ' kPa');
            if (d.swt3Kpa != null) chameleonParts.push('SWT3 ' + d.swt3Kpa + ' kPa');
        }
        if (chameleonParts.length) {
            node.status({ fill: d.chameleonStatusFlags ? 'yellow' : 'blue', shape: 'dot', text: chameleonParts.join(' | ') });
        }
```

If the existing dendrometer block already calls `node.status`, place this status block after it so Chameleon status is visible on Chameleon frames.

- [x] **Step 5: Store SWT values in `device_data`**

In `lsn50-sql-fn`, add `swt_1, swt_2, swt_3` to the non-MOD9 `INSERT INTO device_data` column list immediately after `adc_ch1v`, and add these values in the same position:

```js
'  ' + sqlNum(d.swt1Kpa) + ',',
'  ' + sqlNum(d.swt2Kpa) + ',',
'  ' + sqlNum(d.swt3Kpa) + ',',
```

The resulting non-MOD9 column list must contain:

```sql
deveui, ext_temperature_c, bat_v, adc_ch0v, adc_ch1v, swt_1, swt_2, swt_3,
dendro_ratio, dendro_mode_used, dendro_position_raw_mm, dendro_position_mm,
dendro_valid, dendro_delta_mm, dendro_stem_change_um,
dendro_saturated, dendro_saturation_side,
lsn50_mode_code, lsn50_mode_label, lsn50_mode_observed_at, recorded_at
```

- [x] **Step 6: Allow Chameleon frames into dendrometer persistence when dendro is enabled**

Change `dendro-readings-insert-fn` first guard from:

```js
if (!d || d.detectedMode === 9 || d.isChameleon === true) return null;
```

to:

```js
if (!d || d.detectedMode === 9) return null;
```

The next guard already requires `d.dendroValid` and `d.positionMm`, so Chameleon frames with `dendro_enabled=0` still skip dendrometer persistence.

- [x] **Step 7: Update verifiers for coexistence**

In `scripts/verify-lsn50-chameleon-persistence.js`, replace assertions that require a dedicated Chameleon branch and Chameleon dendrometer skip with:

```js
assertIncludes(apply, 'chameleon.buildChameleonSwtMetrics', 'apply-config derives Chameleon SWT without bypassing dendrometer');
assertIncludes(apply, 'd.swt1Kpa = swt.swt1Kpa;', 'apply-config stores Chameleon SWT1');
assertIncludes(apply, 'if (!dendroEnabled)', 'apply-config keeps dendrometer gated by dendro_enabled');
assert(!apply.includes('} else if (d.isChameleon === true) {'), 'apply-config must not bypass dendrometer for Chameleon frames');
assert(!dendroInsert.includes('d.isChameleon === true'), 'dendrometer insert must not skip Chameleon frames by type');
```

In `scripts/verify-sync-flow.js`, update the corresponding old assertions near the Chameleon section to the same expectations.

- [x] **Step 8: Run backend verifiers**

Run:

```bash
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-lsn50-chameleon-swt.js
node scripts/verify-sync-flow.js
```

Expected: the Chameleon SWT verifier still FAILS until API/GET devices/history/scheduler changes land in Task 5. Codec and persistence should PASS.

- [x] **Step 9: Commit backend derivation**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        scripts/verify-lsn50-chameleon-persistence.js \
        scripts/verify-sync-flow.js
git commit -m "feat: derive chameleon swt from lsn50 uplinks"
```

## Task 5: Local API, Device List, History, And Scheduler

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`

- [x] **Step 1: Return Chameleon config and latest values from GET `/api/devices`**

In `format-devices`, select these `device_data` columns:

```js
'  dd.swt_1,',
'  dd.swt_2,',
'  dd.swt_3,',
```

Add a latest Chameleon join to the query:

```sql
LEFT JOIN (
  SELECT cr.*
  FROM chameleon_readings cr
  INNER JOIN (
    SELECT deveui, MAX(recorded_at) AS max_time
    FROM chameleon_readings
    WHERE deveui IN (${deveuiList})
    GROUP BY deveui
  ) latest_chameleon
    ON cr.deveui = latest_chameleon.deveui
   AND cr.recorded_at = latest_chameleon.max_time
) cr ON cr.deveui = dd.deveui
```

Select these latest Chameleon columns:

```js
'  cr.payload_version AS chameleon_payload_version,',
'  cr.status_flags AS chameleon_status_flags,',
'  cr.i2c_missing AS chameleon_i2c_missing,',
'  cr.timeout AS chameleon_timeout,',
'  cr.temp_fault AS chameleon_temp_fault,',
'  cr.id_fault AS chameleon_id_fault,',
'  cr.ch1_open AS chameleon_ch1_open,',
'  cr.ch2_open AS chameleon_ch2_open,',
'  cr.ch3_open AS chameleon_ch3_open,',
'  cr.temp_c AS chameleon_temp_c,',
'  cr.r1_ohm_comp AS chameleon_r1_ohm_comp,',
'  cr.r2_ohm_comp AS chameleon_r2_ohm_comp,',
'  cr.r3_ohm_comp AS chameleon_r3_ohm_comp,',
'  cr.r1_ohm_raw AS chameleon_r1_ohm_raw,',
'  cr.r2_ohm_raw AS chameleon_r2_ohm_raw,',
'  cr.r3_ohm_raw AS chameleon_r3_ohm_raw,',
'  cr.array_id AS chameleon_array_id,',
```

In `merge-device-data`, copy the selected values into `latest_data` with the same camel/snake style already used by other fields:

```js
swt_1: latest.swt_1,
swt_2: latest.swt_2,
swt_3: latest.swt_3,
chameleon_payload_version: latest.chameleon_payload_version,
chameleon_status_flags: latest.chameleon_status_flags,
chameleon_i2c_missing: latest.chameleon_i2c_missing,
chameleon_timeout: latest.chameleon_timeout,
chameleon_temp_fault: latest.chameleon_temp_fault,
chameleon_id_fault: latest.chameleon_id_fault,
chameleon_ch1_open: latest.chameleon_ch1_open,
chameleon_ch2_open: latest.chameleon_ch2_open,
chameleon_ch3_open: latest.chameleon_ch3_open,
chameleon_temp_c: latest.chameleon_temp_c,
chameleon_r1_ohm_comp: latest.chameleon_r1_ohm_comp,
chameleon_r2_ohm_comp: latest.chameleon_r2_ohm_comp,
chameleon_r3_ohm_comp: latest.chameleon_r3_ohm_comp,
chameleon_r1_ohm_raw: latest.chameleon_r1_ohm_raw,
chameleon_r2_ohm_raw: latest.chameleon_r2_ohm_raw,
chameleon_r3_ohm_raw: latest.chameleon_r3_ohm_raw,
chameleon_array_id: latest.chameleon_array_id,
```

Also return device-level config:

```js
chameleon_enabled: d.chameleon_enabled ?? 0,
chameleon_swt1_depth_cm: d.chameleon_swt1_depth_cm ?? null,
chameleon_swt2_depth_cm: d.chameleon_swt2_depth_cm ?? null,
chameleon_swt3_depth_cm: d.chameleon_swt3_depth_cm ?? null,
chameleon_swt1_a: d.chameleon_swt1_a ?? null,
chameleon_swt1_b: d.chameleon_swt1_b ?? null,
chameleon_swt1_c: d.chameleon_swt1_c ?? null,
chameleon_swt2_a: d.chameleon_swt2_a ?? null,
chameleon_swt2_b: d.chameleon_swt2_b ?? null,
chameleon_swt2_c: d.chameleon_swt2_c ?? null,
chameleon_swt3_a: d.chameleon_swt3_a ?? null,
chameleon_swt3_b: d.chameleon_swt3_b ?? null,
chameleon_swt3_c: d.chameleon_swt3_c ?? null,
```

- [x] **Step 2: Add Chameleon config endpoints**

Add these HTTP routes near the dendrometer config routes:

```text
PUT /api/devices/:deveui/chameleon
PUT /api/devices/:deveui/chameleon-config
```

Create `put-chameleon-enabled-auth-fn` by copying the authentication helpers from `put-dendro-config-auth-fn` unchanged, then replacing the post-auth body with this code:

```js
const auth = verifyBearer(msg.req?.headers?.authorization);
const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();
let body = msg.req_body;
if (typeof body === 'string') {
  try { body = JSON.parse(body); } catch (_) { body = {}; }
}
if (!body || typeof body !== 'object') body = {};
const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1' || body.enabled === 'true' ? 1 : 0;

const db = new osiDb.Database('/data/db/farming.db');
const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, function(error) {
  if (error) reject(error);
  else resolve(this && this.changes ? this.changes : 0);
}));
const close = () => new Promise((resolve) => db.close(() => resolve()));

try {
  const changes = await run(
    "UPDATE devices SET chameleon_enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE deveui = ? AND user_id = ? AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL",
    [enabled, deveui, auth.userId]
  );
  await close();
  if (!changes) {
    msg.statusCode = 404;
    msg.payload = { message: 'Device not found' };
    return msg;
  }
  msg.statusCode = 200;
  msg.payload = { deveui, chameleon_enabled: enabled };
  return msg;
} catch (error) {
  try { await close(); } catch (_) {}
  msg.statusCode = 500;
  msg.payload = { message: 'Failed to update Chameleon enable state', error: String(error && error.message ? error.message : error) };
  return msg;
}
```

Create `put-chameleon-config-auth-fn` by copying the authentication helpers from `put-dendro-config-auth-fn` unchanged, then replacing the post-auth body with this code. It accepts these body keys in camelCase or snake_case:

```js
[
  'chameleon_swt1_depth_cm', 'chameleonSwt1DepthCm',
  'chameleon_swt2_depth_cm', 'chameleonSwt2DepthCm',
  'chameleon_swt3_depth_cm', 'chameleonSwt3DepthCm',
  'chameleon_swt1_a', 'chameleonSwt1A',
  'chameleon_swt1_b', 'chameleonSwt1B',
  'chameleon_swt1_c', 'chameleonSwt1C',
  'chameleon_swt2_a', 'chameleonSwt2A',
  'chameleon_swt2_b', 'chameleonSwt2B',
  'chameleon_swt2_c', 'chameleonSwt2C',
  'chameleon_swt3_a', 'chameleonSwt3A',
  'chameleon_swt3_b', 'chameleonSwt3B',
  'chameleon_swt3_c', 'chameleonSwt3C',
]
```

Validation rules:

```js
function parseNullableNumber(value, label, options) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(label + ' must be a finite number');
  if (options && options.positive && n <= 0) throw new Error(label + ' must be greater than zero');
  return Math.round(n * 1000000) / 1000000;
}
```

Use this complete post-auth body:

```js
const auth = verifyBearer(msg.req?.headers?.authorization);
const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();
let body = msg.req_body;
if (typeof body === 'string') {
  try { body = JSON.parse(body); } catch (_) { body = {}; }
}
if (!body || typeof body !== 'object') body = {};

function readBody(snake, camel) {
  if (Object.prototype.hasOwnProperty.call(body, camel)) return body[camel];
  if (Object.prototype.hasOwnProperty.call(body, snake)) return body[snake];
  return undefined;
}
function parseNullableNumber(value, label, options) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(label + ' must be a finite number');
  if (options && options.positive && n <= 0) throw new Error(label + ' must be greater than zero');
  return Math.round(n * 1000000) / 1000000;
}

let patch;
try {
  patch = {
    chameleon_swt1_depth_cm: parseNullableNumber(readBody('chameleon_swt1_depth_cm', 'chameleonSwt1DepthCm'), 'SWT1 depth', { positive: true }),
    chameleon_swt2_depth_cm: parseNullableNumber(readBody('chameleon_swt2_depth_cm', 'chameleonSwt2DepthCm'), 'SWT2 depth', { positive: true }),
    chameleon_swt3_depth_cm: parseNullableNumber(readBody('chameleon_swt3_depth_cm', 'chameleonSwt3DepthCm'), 'SWT3 depth', { positive: true }),
    chameleon_swt1_a: parseNullableNumber(readBody('chameleon_swt1_a', 'chameleonSwt1A'), 'SWT1 coefficient a'),
    chameleon_swt1_b: parseNullableNumber(readBody('chameleon_swt1_b', 'chameleonSwt1B'), 'SWT1 coefficient b'),
    chameleon_swt1_c: parseNullableNumber(readBody('chameleon_swt1_c', 'chameleonSwt1C'), 'SWT1 coefficient c'),
    chameleon_swt2_a: parseNullableNumber(readBody('chameleon_swt2_a', 'chameleonSwt2A'), 'SWT2 coefficient a'),
    chameleon_swt2_b: parseNullableNumber(readBody('chameleon_swt2_b', 'chameleonSwt2B'), 'SWT2 coefficient b'),
    chameleon_swt2_c: parseNullableNumber(readBody('chameleon_swt2_c', 'chameleonSwt2C'), 'SWT2 coefficient c'),
    chameleon_swt3_a: parseNullableNumber(readBody('chameleon_swt3_a', 'chameleonSwt3A'), 'SWT3 coefficient a'),
    chameleon_swt3_b: parseNullableNumber(readBody('chameleon_swt3_b', 'chameleonSwt3B'), 'SWT3 coefficient b'),
    chameleon_swt3_c: parseNullableNumber(readBody('chameleon_swt3_c', 'chameleonSwt3C'), 'SWT3 coefficient c'),
  };
} catch (error) {
  msg.statusCode = 400;
  msg.payload = { message: String(error && error.message ? error.message : error) };
  return msg;
}

const supplied = Object.keys(patch).filter((key) => {
  const camel = key.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
  return Object.prototype.hasOwnProperty.call(body, key) || Object.prototype.hasOwnProperty.call(body, camel);
});
if (supplied.length === 0) {
  msg.statusCode = 400;
  msg.payload = { message: 'No Chameleon config fields supplied' };
  return msg;
}

const assignments = supplied.map((key) => key + ' = ?');
const params = supplied.map((key) => patch[key]);
params.push(deveui, auth.userId);

const db = new osiDb.Database('/data/db/farming.db');
const run = (sql, values) => new Promise((resolve, reject) => db.run(sql, values, function(error) {
  if (error) reject(error);
  else resolve(this && this.changes ? this.changes : 0);
}));
const close = () => new Promise((resolve) => db.close(() => resolve()));

try {
  const changes = await run(
    "UPDATE devices SET " + assignments.join(', ') + ", updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE deveui = ? AND user_id = ? AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL",
    params
  );
  await close();
  if (!changes) {
    msg.statusCode = 404;
    msg.payload = { message: 'Device not found' };
    return msg;
  }
  msg.statusCode = 200;
  msg.payload = Object.assign({ deveui }, patch);
  return msg;
} catch (error) {
  try { await close(); } catch (_) {}
  msg.statusCode = 500;
  msg.payload = { message: 'Failed to update Chameleon config', error: String(error && error.message ? error.message : error) };
  return msg;
}
```

- [x] **Step 3: Allow SWT history fields**

In `sensor-history-fn`, add these entries to `ALLOWED_FIELDS`:

```js
'swt_1', 'swt_2', 'swt_3'
```

- [x] **Step 4: Include Chameleon-enabled LSN50 devices in scheduler SWT query**

In `d0b2b1c1a937e16d` (`Build mean query (last hour, all datapoints)`), replace the SWT expression block with:

```js
let expr = "COALESCE(dd.swt_1, dd.swt_wm1)";
if (metric === "SWT_WM2" || metric === "SWT_2") expr = "COALESCE(dd.swt_2, dd.swt_wm2)";
if (metric === "SWT_WM3" || metric === "SWT_3") expr = "COALESCE(dd.swt_3, NULL)";
if (metric === "SWT_AVG") {
  expr = "((COALESCE(dd.swt_1,dd.swt_wm1,0) + COALESCE(dd.swt_2,dd.swt_wm2,0) + COALESCE(dd.swt_3,0)) / NULLIF((CASE WHEN COALESCE(dd.swt_1,dd.swt_wm1) IS NULL THEN 0 ELSE 1 END + CASE WHEN COALESCE(dd.swt_2,dd.swt_wm2) IS NULL THEN 0 ELSE 1 END + CASE WHEN dd.swt_3 IS NULL THEN 0 ELSE 1 END),0))";
}
```

Replace the device type filter with:

```sql
AND (
  ds.type_id IN ('KIWI_SENSOR', 'TEKTELIC_CLOVER')
  OR (ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1)
)
```

- [x] **Step 5: Allow modern SWT trigger metrics in schedule validation**

In `Verify Zone Ownership`, replace:

```js
const allowed = ['SWT_WM1', 'SWT_WM2', 'SWT_AVG', 'DENDRO'];
```

with:

```js
const allowed = ['SWT_1', 'SWT_2', 'SWT_3', 'SWT_AVG', 'SWT_WM1', 'SWT_WM2', 'SWT_WM3', 'DENDRO'];
```

- [x] **Step 6: Update sync-flow verifier expectations**

Add assertions to `scripts/verify-sync-flow.js`:

```js
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE devices ADD COLUMN chameleon_enabled INTEGER DEFAULT 0', 'adds Chameleon enable flag');
expectIncludes('Sync Init Schema + Triggers', 'ALTER TABLE device_data ADD COLUMN swt_1 REAL', 'adds canonical SWT1 storage');
expectIncludesById('lsn50-sql-fn', 'swt_1, swt_2, swt_3', 'persists Chameleon SWT channels into device_data');
expectIncludesById('format-devices', 'dd.swt_1', 'returns Chameleon SWT1 in GET /api/devices');
expectIncludesById('merge-device-data', 'chameleon_enabled: d.chameleon_enabled ?? 0', 'returns Chameleon enable state in GET /api/devices');
expectIncludesById('sensor-history-fn', "'swt_3'", 'allows SWT3 history');
expectIncludesById('d0b2b1c1a937e16d', "ds.type_id = 'DRAGINO_LSN50' AND COALESCE(ds.chameleon_enabled,0) = 1", 'includes Chameleon-enabled LSN50 devices in SWT schedules');
```

- [x] **Step 7: Run backend verifiers**

Run:

```bash
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-lsn50-chameleon-swt.js
node scripts/verify-sync-flow.js
```

Expected: all four PASS.

- [x] **Step 8: Commit local API and scheduler changes**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        scripts/verify-sync-flow.js
git commit -m "feat: expose chameleon swt in edge api"
```

## Task 6: React Types And API Client

**Files:**
- Modify: `web/react-gui/src/types/farming.ts`
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `scripts/verify-sync-flow.js`

- [x] **Step 1: Extend Device types**

Add to `Device.latest_data`:

```ts
swt_1?: number | null;
swt_2?: number | null;
swt_3?: number | null;
chameleon_payload_version?: number | null;
chameleon_status_flags?: number | null;
chameleon_i2c_missing?: number | null;
chameleon_timeout?: number | null;
chameleon_temp_fault?: number | null;
chameleon_id_fault?: number | null;
chameleon_ch1_open?: number | null;
chameleon_ch2_open?: number | null;
chameleon_ch3_open?: number | null;
chameleon_temp_c?: number | null;
chameleon_r1_ohm_comp?: number | null;
chameleon_r2_ohm_comp?: number | null;
chameleon_r3_ohm_comp?: number | null;
chameleon_r1_ohm_raw?: number | null;
chameleon_r2_ohm_raw?: number | null;
chameleon_r3_ohm_raw?: number | null;
chameleon_array_id?: string | null;
```

Add to device-level fields:

```ts
chameleon_enabled?: number;
chameleon_swt1_depth_cm?: number | null;
chameleon_swt2_depth_cm?: number | null;
chameleon_swt3_depth_cm?: number | null;
chameleon_swt1_a?: number | null;
chameleon_swt1_b?: number | null;
chameleon_swt1_c?: number | null;
chameleon_swt2_a?: number | null;
chameleon_swt2_b?: number | null;
chameleon_swt2_c?: number | null;
chameleon_swt3_a?: number | null;
chameleon_swt3_b?: number | null;
chameleon_swt3_c?: number | null;
```

- [x] **Step 2: Add API payload type**

Add to `web/react-gui/src/services/api.ts` above `lsn50API`:

```ts
export interface ChameleonConfigPayload {
  chameleonSwt1DepthCm?: number | null;
  chameleonSwt2DepthCm?: number | null;
  chameleonSwt3DepthCm?: number | null;
  chameleonSwt1A?: number | null;
  chameleonSwt1B?: number | null;
  chameleonSwt1C?: number | null;
  chameleonSwt2A?: number | null;
  chameleonSwt2B?: number | null;
  chameleonSwt2C?: number | null;
  chameleonSwt3A?: number | null;
  chameleonSwt3B?: number | null;
  chameleonSwt3C?: number | null;
}
```

- [x] **Step 3: Add Chameleon client methods**

Add methods to `lsn50API`:

```ts
setChameleonEnabled: async (deveui: string, enabled: boolean): Promise<void> => {
  await api.put(`/api/devices/${deveui}/chameleon`, { enabled });
},
setChameleonConfig: async (deveui: string, payload: ChameleonConfigPayload): Promise<void> => {
  await api.put(`/api/devices/${deveui}/chameleon-config`, payload);
},
```

- [x] **Step 4: Update sync verifier UI/API assertions**

Add to `scripts/verify-sync-flow.js`:

```js
expectFileIncludes('farming.ts', farmingTypesSource, 'chameleon_enabled?: number;', 'types Chameleon enable flag');
expectFileIncludes('farming.ts', farmingTypesSource, 'swt_3?: number | null;', 'types Chameleon SWT3 latest data');
expectFileIncludes('api.ts', reactGuiApiSource, 'setChameleonEnabled: async', 'adds Chameleon enable API helper');
expectFileIncludes('api.ts', reactGuiApiSource, 'setChameleonConfig: async', 'adds Chameleon config API helper');
```

- [x] **Step 5: Run TypeScript and flow verification**

Run:

```bash
node scripts/verify-sync-flow.js
cd web/react-gui && npm run test:unit
```

Expected: `verify-sync-flow.js` may still FAIL until GUI components land in Task 7. TypeScript unit tests PASS.

- [x] **Step 6: Commit types and API client**

```bash
git add web/react-gui/src/types/farming.ts web/react-gui/src/services/api.ts scripts/verify-sync-flow.js
git commit -m "feat: add chameleon swt api client"
```

## Task 7: Chameleon Settings UI

**Files:**
- Create: `web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx`
- Modify: `web/react-gui/src/components/farming/DraginoSettingsModal.tsx`
- Modify: `scripts/verify-sync-flow.js`

- [x] **Step 1: Create the Chameleon settings section**

Create `web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx`:

```tsx
import React, { useMemo, useState } from 'react';
import type { Device } from '../../types/farming';
import { lsn50API } from '../../services/api';

const DEFAULTS = {
  swt1: { a: 10.71, b: 0.13, c: 7.18 },
  swt2: { a: 10.4, b: 0.13, c: 7.31 },
  swt3: { a: 10.33, b: 0.12, c: 7.21 },
};

const FOCUS_VISIBLE_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';

function toInput(value: number | null | undefined, fallback?: number): string {
  const numeric = value ?? fallback ?? null;
  return numeric == null || !Number.isFinite(Number(numeric)) ? '' : String(numeric);
}

function parseOptionalPositive(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return Math.round(numeric * 100) / 100;
}

function parseFinite(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return Math.round(numeric * 1000000) / 1000000;
}

type Props = {
  device: Device;
  onUpdate: () => void;
};

export const DraginoChameleonSwtSection: React.FC<Props> = ({ device, onUpdate }) => {
  const latest = device.latest_data || {};
  const [swt1Depth, setSwt1Depth] = useState(toInput(device.chameleon_swt1_depth_cm));
  const [swt2Depth, setSwt2Depth] = useState(toInput(device.chameleon_swt2_depth_cm));
  const [swt3Depth, setSwt3Depth] = useState(toInput(device.chameleon_swt3_depth_cm));
  const [swt1A, setSwt1A] = useState(toInput(device.chameleon_swt1_a, DEFAULTS.swt1.a));
  const [swt1B, setSwt1B] = useState(toInput(device.chameleon_swt1_b, DEFAULTS.swt1.b));
  const [swt1C, setSwt1C] = useState(toInput(device.chameleon_swt1_c, DEFAULTS.swt1.c));
  const [swt2A, setSwt2A] = useState(toInput(device.chameleon_swt2_a, DEFAULTS.swt2.a));
  const [swt2B, setSwt2B] = useState(toInput(device.chameleon_swt2_b, DEFAULTS.swt2.b));
  const [swt2C, setSwt2C] = useState(toInput(device.chameleon_swt2_c, DEFAULTS.swt2.c));
  const [swt3A, setSwt3A] = useState(toInput(device.chameleon_swt3_a, DEFAULTS.swt3.a));
  const [swt3B, setSwt3B] = useState(toInput(device.chameleon_swt3_b, DEFAULTS.swt3.b));
  const [swt3C, setSwt3C] = useState(toInput(device.chameleon_swt3_c, DEFAULTS.swt3.c));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const channelRows = useMemo(() => [
    { id: 1, label: 'SWT1', depth: swt1Depth, setDepth: setSwt1Depth, a: swt1A, setA: setSwt1A, b: swt1B, setB: setSwt1B, c: swt1C, setC: setSwt1C, kpa: latest.swt_1, resistance: latest.chameleon_r1_ohm_comp },
    { id: 2, label: 'SWT2', depth: swt2Depth, setDepth: setSwt2Depth, a: swt2A, setA: setSwt2A, b: swt2B, setB: setSwt2B, c: swt2C, setC: setSwt2C, kpa: latest.swt_2, resistance: latest.chameleon_r2_ohm_comp },
    { id: 3, label: 'SWT3', depth: swt3Depth, setDepth: setSwt3Depth, a: swt3A, setA: setSwt3A, b: swt3B, setB: setSwt3B, c: swt3C, setC: setSwt3C, kpa: latest.swt_3, resistance: latest.chameleon_r3_ohm_comp },
  ], [latest, swt1Depth, swt2Depth, swt3Depth, swt1A, swt1B, swt1C, swt2A, swt2B, swt2C, swt3A, swt3B, swt3C]);

  const restoreDefaults = () => {
    setSwt1A(String(DEFAULTS.swt1.a)); setSwt1B(String(DEFAULTS.swt1.b)); setSwt1C(String(DEFAULTS.swt1.c));
    setSwt2A(String(DEFAULTS.swt2.a)); setSwt2B(String(DEFAULTS.swt2.b)); setSwt2C(String(DEFAULTS.swt2.c));
    setSwt3A(String(DEFAULTS.swt3.a)); setSwt3B(String(DEFAULTS.swt3.b)); setSwt3C(String(DEFAULTS.swt3.c));
    setMessage('Workbook default coefficients restored locally. Save to apply them.');
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await lsn50API.setChameleonConfig(device.deveui, {
        chameleonSwt1DepthCm: parseOptionalPositive(swt1Depth, 'SWT1 depth'),
        chameleonSwt2DepthCm: parseOptionalPositive(swt2Depth, 'SWT2 depth'),
        chameleonSwt3DepthCm: parseOptionalPositive(swt3Depth, 'SWT3 depth'),
        chameleonSwt1A: parseFinite(swt1A, 'SWT1 coefficient a'),
        chameleonSwt1B: parseFinite(swt1B, 'SWT1 coefficient b'),
        chameleonSwt1C: parseFinite(swt1C, 'SWT1 coefficient c'),
        chameleonSwt2A: parseFinite(swt2A, 'SWT2 coefficient a'),
        chameleonSwt2B: parseFinite(swt2B, 'SWT2 coefficient b'),
        chameleonSwt2C: parseFinite(swt2C, 'SWT2 coefficient c'),
        chameleonSwt3A: parseFinite(swt3A, 'SWT3 coefficient a'),
        chameleonSwt3B: parseFinite(swt3B, 'SWT3 coefficient b'),
        chameleonSwt3C: parseFinite(swt3C, 'SWT3 coefficient c'),
      });
      setMessage('Chameleon calibration saved.');
      onUpdate();
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to save Chameleon calibration');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3">
        {channelRows.map((channel) => (
          <div key={channel.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[var(--text)]">{channel.label}</p>
              <p className="text-xs text-[var(--text-tertiary)]">
                {channel.kpa != null ? `${Number(channel.kpa).toFixed(1)} kPa` : 'No SWT yet'}
                {channel.resistance != null ? ` · ${Number(channel.resistance).toFixed(0)} ohm` : ''}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                Depth cm
                <input value={channel.depth} onChange={(event) => channel.setDepth(event.target.value)} inputMode="decimal" className={`mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`} />
              </label>
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                a
                <input value={channel.a} onChange={(event) => channel.setA(event.target.value)} inputMode="decimal" className={`mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`} />
              </label>
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                b
                <input value={channel.b} onChange={(event) => channel.setB(event.target.value)} inputMode="decimal" className={`mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`} />
              </label>
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                c
                <input value={channel.c} onChange={(event) => channel.setC(event.target.value)} inputMode="decimal" className={`mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-sm text-[var(--text)] ${FOCUS_VISIBLE_RING}`} />
              </label>
            </div>
          </div>
        ))}
      </div>

      {error && <p className="rounded-md bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">{error}</p>}
      {message && <p className="rounded-md bg-[var(--success-bg)] px-3 py-2 text-sm text-[var(--success-text)]">{message}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={busy} className={`rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-50 ${FOCUS_VISIBLE_RING}`}>
          {busy ? 'Saving...' : 'Save Chameleon calibration'}
        </button>
        <button type="button" onClick={restoreDefaults} disabled={busy} className={`rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--card)] disabled:opacity-50 ${FOCUS_VISIBLE_RING}`}>
          Restore workbook defaults
        </button>
      </div>
    </div>
  );
};
```

- [x] **Step 2: Add Chameleon to the LSN50 settings modal**

In `DraginoSettingsModal.tsx`, import the section:

```ts
import { DraginoChameleonSwtSection } from './DraginoChameleonSwtSection';
```

Extend `SENSOR_OPTIONS` key type with `chameleon_enabled` and add:

```ts
{ key: 'chameleon_enabled', label: 'Chameleon SWT', toggle: (id, enabled) => lsn50API.setChameleonEnabled(id, enabled) },
```

Replace `requiresMod9Counter` with:

```ts
function requiredModeForSensor(
  key: 'temp_enabled' | 'dendro_enabled' | 'rain_gauge_enabled' | 'flow_meter_enabled' | 'chameleon_enabled',
): Lsn50Mode | null {
  if (key === 'rain_gauge_enabled' || key === 'flow_meter_enabled') return 'MOD9';
  if (key === 'chameleon_enabled') return 'MOD3';
  return null;
}
```

Update the toggle guard:

```ts
const requiredMode = requiredModeForSensor(option.key);
const modeReady = !requiredMode || currentMode === requiredMode || pendingMode === requiredMode;
if (!current && !modeReady) {
  setError(`${option.label} requires ${requiredMode}. Apply ${requiredMode} before enabling it.`);
  return;
}
```

Update the mode confirmation warning so MOD3 is accepted when Chameleon or ratio dendrometer is active:

```ts
const chameleonActive = device.chameleon_enabled === 1;
const dendroActive = device.dendro_enabled === 1;
const switchingAwayFromRequiredMode =
  (selectedMode !== 'MOD3' && chameleonActive)
  || (selectedMode !== 'MOD9' && (device.rain_gauge_enabled === 1 || device.flow_meter_enabled === 1));
const switchingAwayFromDendroDataMode = dendroActive && selectedMode !== 'MOD1' && selectedMode !== 'MOD3';
if (
  (switchingAwayFromRequiredMode || switchingAwayFromDendroDataMode)
  && !window.confirm('The selected LSN50 mode does not match one enabled sensor path. Continue?')
) {
  return;
}
```

Render the dedicated section near the dendrometer calibration section:

```tsx
<SettingsSection
  title="Chameleon SWT"
  description="MOD3 Chameleon resistance conversion. Depths label SWT history and coefficients drive kPa conversion."
>
  <DraginoChameleonSwtSection device={device} onUpdate={onUpdate} />
</SettingsSection>
```

- [x] **Step 3: Update verifier UI assertions**

Add to `scripts/verify-sync-flow.js`:

```js
const draginoChameleonSource = fs.readFileSync(path.resolve(__dirname, '..', 'web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx'), 'utf8');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, 'Chameleon SWT', 'adds Chameleon SWT settings section');
expectFileIncludes('DraginoSettingsModal.tsx', draginoSettingsModalSource, 'requiredModeForSensor', 'gates Chameleon enablement by MOD3 without blocking dendrometer');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSource, 'Save Chameleon calibration', 'renders Chameleon calibration save action');
expectFileIncludes('DraginoChameleonSwtSection.tsx', draginoChameleonSource, 'Restore workbook defaults', 'offers workbook coefficient defaults');
```

- [x] **Step 4: Run GUI verification**

Run:

```bash
node scripts/verify-sync-flow.js
cd web/react-gui && npm run test:unit
cd web/react-gui && npm run build
```

Expected: `verify-sync-flow.js` may still FAIL until card display lands in Task 8. Unit tests and build PASS.

- [x] **Step 5: Commit settings UI**

```bash
git add web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx \
        web/react-gui/src/components/farming/DraginoSettingsModal.tsx \
        scripts/verify-sync-flow.js
git commit -m "feat: add chameleon calibration settings"
```

## Task 8: LSN50 Card SWT Display And ADC Hiding

**Files:**
- Modify: `web/react-gui/src/components/farming/DraginoTempCard.tsx`
- Modify: `scripts/verify-sync-flow.js`

- [x] **Step 1: Add Chameleon display helpers**

Add near existing format helpers:

```ts
function formatDepthLabel(value: number | null | undefined): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return `${Number.isInteger(numeric) ? numeric.toFixed(0) : numeric.toFixed(1)} cm`;
}

function formatKpa(value: number | null | undefined): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)} kPa` : '—';
}
```

- [x] **Step 2: Compute Chameleon card state**

Inside `DraginoTempCard`, add:

```ts
const chameleonEnabled = device.chameleon_enabled === 1;
const chameleonDataInvalid = data?.chameleon_i2c_missing === 1 || data?.chameleon_timeout === 1;
const chameleonChannels = [
  { field: 'swt_1', label: 'SWT1', value: data?.swt_1, depth: device.chameleon_swt1_depth_cm, color: '#0f766e' },
  { field: 'swt_2', label: 'SWT2', value: data?.swt_2, depth: device.chameleon_swt2_depth_cm, color: '#2563eb' },
  { field: 'swt_3', label: 'SWT3', value: data?.swt_3, depth: device.chameleon_swt3_depth_cm, color: '#7c3aed' },
] as const;
```

- [x] **Step 3: Render Chameleon SWT cards**

Place this block after battery and before rain/flow cards:

```tsx
{chameleonEnabled && (
  <div className="rounded-lg bg-[var(--card)] p-3">
    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Chameleon SWT</p>
    {chameleonDataInvalid ? (
      <p className="text-base font-bold text-[var(--warn-text)]">No valid Chameleon sample</p>
    ) : (
      <div className="grid grid-cols-1 gap-2">
        {chameleonChannels.map((channel) => (
          <button
            key={channel.field}
            type="button"
            onClick={() => setSensorMonitor({
              field: channel.field,
              initialField: channel.field,
              label: channel.label,
              unit: 'kPa',
              color: channel.color,
              decimals: 1,
              seriesOptions: chameleonChannels.map((option) => ({
                field: option.field,
                label: option.label,
                unit: 'kPa',
                color: option.color,
                decimals: 1,
              })),
            })}
            className={`flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left transition-colors hover:border-[var(--focus)] ${FOCUS_VISIBLE_RING}`}
            title="View SWT history"
          >
            <span>
              <span className="block text-sm font-semibold text-[var(--text)]">{channel.label}</span>
              <span className="block text-xs text-[var(--text-tertiary)]">{formatDepthLabel(channel.depth) || 'Depth unset'}</span>
            </span>
            <span className="text-lg font-bold tabular-nums text-[var(--text)]">{formatKpa(channel.value)}</span>
          </button>
        ))}
      </div>
    )}
  </div>
)}
```

- [x] **Step 4: Hide generic ADC card when dendrometer is disabled**

Delete this block:

```tsx
{!dendroEnabled && data?.adc_ch0v != null && data.adc_ch0v > 0.01 && (
  <div className="rounded-lg bg-[var(--card)] p-3">
    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">ADC INPUT</p>
    <button
      onClick={() => setSensorMonitor({ field: 'adc_ch0v', label: 'ADC Input', unit: 'V', color: '#8b5cf6', decimals: 3 })}
      className={`cursor-pointer text-left text-2xl font-bold tabular-nums text-[var(--text)] underline decoration-dotted underline-offset-4 transition-colors hover:text-[var(--primary)] ${FOCUS_VISIBLE_RING}`}
      title="View history"
    >
      {data.adc_ch0v.toFixed(3)} V
    </button>
  </div>
)}
```

Do not add a replacement ADC card. Dendrometer-specific ADC diagnostics remain in the dendrometer monitor/calibration UI.

- [x] **Step 5: Add verifier assertions**

Add to `scripts/verify-sync-flow.js`:

```js
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, 'Chameleon SWT', 'renders Chameleon SWT on the LSN50 card');
expectFileIncludes('DraginoTempCard.tsx', draginoTempCardSource, "field: 'swt_3'", 'opens history for Chameleon SWT3');
expectFileExcludes('DraginoTempCard.tsx', draginoTempCardSource, 'ADC INPUT', 'removes generic ADC card when dendrometer is disabled');
```

- [x] **Step 6: Run GUI verification**

Run:

```bash
node scripts/verify-sync-flow.js
cd web/react-gui && npm run test:unit
cd web/react-gui && npm run build
```

Expected: all PASS.

- [x] **Step 7: Commit card display**

```bash
git add web/react-gui/src/components/farming/DraginoTempCard.tsx scripts/verify-sync-flow.js
git commit -m "feat: show chameleon swt on lsn50 card"
```

## Task 9: End-To-End Verification And Review

**Files:**
- No planned source edits. A verification failure should produce a narrow patch in the exact file named by the failing assertion.

- [x] **Step 1: Run backend verifiers**

```bash
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-lsn50-chameleon-swt.js
node scripts/verify-sync-flow.js
```

Expected:

```text
LSN50 Chameleon codec checks passed
LSN50 Chameleon persistence checks passed
LSN50 Chameleon SWT checks passed
verify-sync-flow.js exits with status 0
```

`verify-sync-flow.js` should exit `0`.

- [x] **Step 2: Run GUI checks**

```bash
cd web/react-gui
npm run test:unit
npm run build
```

Expected: tests and production build PASS.

- [x] **Step 3: Inspect git diff for regression risks**

Run:

```bash
BASE=$(git merge-base origin/main HEAD)
git diff --stat "$BASE"..HEAD
git diff "$BASE"..HEAD -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json | sed -n '1,260p'
git diff "$BASE"..HEAD -- web/react-gui/src/components/farming/DraginoTempCard.tsx web/react-gui/src/components/farming/DraginoSettingsModal.tsx | sed -n '1,260p'
```

Review must confirm:

- `d.isChameleon === true` no longer suppresses dendrometer processing.
- `dendro_enabled=0` still leaves dendrometer fields null.
- `chameleon_enabled=0` still records raw `chameleon_readings` but leaves `swt_1/2/3` null.
- Scheduler queries include Chameleon LSN50 devices only when `devices.chameleon_enabled=1`.
- The LSN50 card has no generic ADC display when dendrometer is disabled.
- The settings modal lets dendrometer and Chameleon toggles both be on.

- [x] **Step 4: Run a local smoke test with a known Chameleon sample**

Use the live sample values from the field test:

```bash
node <<'NODE'
const chameleon = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper');
const metrics = chameleon.buildChameleonSwtMetrics({
  r1OhmComp: 874,
  r2OhmComp: 836,
  r3OhmComp: 882,
  i2cMissing: 0,
  timeout: 0,
  ch1Open: 0,
  ch2Open: 0,
  ch3Open: 0,
}, { enabled: 1 });
console.log(metrics);
if (metrics.swt1Kpa !== 5.85 || metrics.swt2Kpa !== 5.56 || metrics.swt3Kpa !== 6.02) {
  process.exit(1);
}
NODE
```

Expected output includes:

```text
swt1Kpa: 5.85
swt2Kpa: 5.56
swt3Kpa: 6.02
```

- [x] **Step 5: Commit any verification fixes**

If no fixes are needed:

```bash
git status --short
```

Expected: clean working tree after previous task commits.

If fixes were needed:

```bash
git status --short
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        scripts/verify-lsn50-chameleon-swt.js \
        scripts/verify-lsn50-chameleon-persistence.js \
        scripts/verify-sync-flow.js \
        web/react-gui/src/types/farming.ts \
        web/react-gui/src/services/api.ts \
        web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx \
        web/react-gui/src/components/farming/DraginoSettingsModal.tsx \
        web/react-gui/src/components/farming/DraginoTempCard.tsx \
        deploy.sh
git commit -m "fix: complete chameleon swt integration verification"
```

## Verification Evidence

Fresh verification run on `2026-05-02` after Task 8 and the invalid-sample regression test:

- `node scripts/verify-lsn50-chameleon-codec.js` -> `LSN50 Chameleon codec checks passed`
- `node scripts/verify-lsn50-chameleon-persistence.js` -> `LSN50 Chameleon persistence checks passed`
- `node scripts/verify-lsn50-chameleon-swt.js` -> `LSN50 Chameleon SWT checks passed`
- `node scripts/verify-sync-flow.js` -> `Sync flow verification passed`
- `cd web/react-gui && npm run test:unit` -> `23` tests passed, `0` failed
- `cd web/react-gui && npm run build` -> production build completed; existing browser data freshness and chunk-size warnings remain
- Chameleon live-sample smoke test returned `{ swt1Kpa: 5.85, swt2Kpa: 5.56, swt3Kpa: 6.02 }`
- `git diff --check` -> no whitespace errors

## Self-Review Checklist

- Spec coverage:
  - Calibration formula: Task 2.
  - Backend conversion to SWT/kPa: Task 4.
  - Chameleon enable flag: Tasks 3, 5, 6, 7.
  - ADC ignored while dendrometer disabled: Task 8.
  - Dendrometer and Chameleon enabled together: Task 4 and Task 8 verification.
  - LSN50 card dedicated Chameleon section with depths and calibration values: Task 7.
  - SWT history and schedule compatibility: Task 5 and Task 8.
- Code-quality notes:
  - The formula lives in one helper package to avoid duplicated calibration math across flow, verifier, and future tests.
  - Raw payload persistence remains separate from derived `device_data` values, keeping protocol storage and domain conversion separate.
  - New GUI is a focused section component instead of expanding the already large settings modal with per-channel form internals.
  - No mutual exclusion is introduced between dendrometer and Chameleon flags.
- Residual risks:
  - Cloud/server UI will not show Chameleon-specific fields until OSI Server is extended.
  - Schedule aggregation can consume `swt_1/2/3`, but operational threshold choices still need field validation once sensors are deployed in soil.
