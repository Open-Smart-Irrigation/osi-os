# LoRain Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the LoRain review findings by aligning the codec with Aqua-Scope's published payload contract, making Node-RED ingestion robust to vendor-style decoded objects, and fixing the async mock used by flow verification.

**Architecture:** Keep the LoRain codec responsible for protocol-level parsing and unit-normalized OSI aliases. Keep the Node-RED `Process LoRain` flow responsible for accepting either OSI-normalized `rain_mm_delta` or vendor-style raw `rainlevel` step counts. Do not change DB schema or React UI in this follow-up.

**Tech Stack:** Node.js verifier scripts, ChirpStack JavaScript payload codec, Node-RED `flows.json`, SQLite-backed flow fixtures.

**References:**
- Aqua-Scope RANLWE01 manual: `https://www.aqua-scope.com/manuals/?html=0&lang=en&sku=RANLWE01&type=m`
- Aqua-Scope published LoRain decoder: `https://raw.githubusercontent.com/aqua-scope/lorain/main/rain_ttn_decoder.js`

---

### Task 1: Lock The Vendor Codec Contract With Failing Tests

**Files:**
- Modify: `scripts/verify-lorain-codec.js`

- [ ] **Step 1: Update the codec sample assertions**

Replace `assertSampleDecode` with:

```js
function assertSampleDecode(decoded) {
  assert.ok(decoded, 'decodeUplink returns a result');
  assert.ok(decoded.data, 'decodeUplink returns decoded data');
  assert.strictEqual((decoded.errors || []).length, 0, 'sample decodes without errors');
  assert.strictEqual(decoded.data.rain_tips_delta, 3, 'rain tip count is decoded');
  assert.strictEqual(decoded.data.rainlevel, 3, 'vendor-compatible rainlevel remains raw 0.5 mm steps');
  assert.strictEqual(decoded.data.rain_mm_delta, 1.5, 'rain delta is normalized to millimeters');
  assert.strictEqual(decoded.data.ambient_temperature, 20.5, 'ambient temperature is normalized');
  assert.strictEqual(decoded.data.temperature_C, 20.5, 'temperature_C alias is normalized');
  assert.strictEqual(decoded.data.uptime_days, 12, 'uptime is decoded in days');
  assert.strictEqual(decoded.data.bat_v, 3.3, 'battery voltage is normalized');
  assert.strictEqual(decoded.data.bat_mAh, 10, 'battery capacity estimate is decoded');
}
```

- [ ] **Step 2: Add documented chained command coverage**

Replace the `sample` declaration with:

```js
const sample = [
  0x03, 0x01, 0x00, 0x03,
  0x04, 0x04, 0x03, 0x84,
  0x06, 0x03, 0x00, 0x0c,
  0x06, 0x81, 0x00, 0x03,
  0x06, 0x01, 0x00, 0xcd,
  0x0a, 0x00, 0x00, 0x00, 0x2a,
  0x0b, 0x01, 0x03, 0x00, 0x0f,
  0x12, 0x21, 0x00, 0x0a,
];
```

Add these assertions after `assertSampleDecode(decodeUplink({ fPort: 2, bytes: sample }));`:

```js
const decoded = decodeUplink({ fPort: 10, bytes: sample });
assert.strictEqual(decoded.data.hw_version, 1, 'hardware version command is decoded');
assert.strictEqual(decoded.data.capabilities, 3, 'capabilities bitmap is decoded');
assert.strictEqual(decoded.data.conf_interval, 900, 'configuration command is decoded');
assert.strictEqual(decoded.data.fw_version, 42, 'firmware version command is decoded');
assert.strictEqual(decoded.data.alarm_status, 1, 'alarm status is decoded');
assert.strictEqual(decoded.data.alarm_type, 3, 'alarm type is decoded');
assert.strictEqual(decoded.data.alarm_value, 15, 'alarm value is decoded');
```

- [ ] **Step 3: Add signed temperature coverage**

Add this assertion before the wrong-FPort test:

```js
const negativeTemp = decodeUplink({ fPort: 10, bytes: [0x06, 0x01, 0xff, 0xea] });
assert.strictEqual(negativeTemp.data.ambient_temperature, -2.2, 'signed temperature is decoded as int16 tenths');
```

- [ ] **Step 4: Run the focused codec verifier and confirm it fails**

Run:

```bash
node scripts/verify-lorain-codec.js
```

Expected: FAIL on at least `vendor-compatible rainlevel remains raw 0.5 mm steps` and `uptime is decoded in days`.

### Task 2: Fix The LoRain Codec Implementation

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js`

- [ ] **Step 1: Replace the canonical codec source in `bcm2712`**

Replace the whole file with:

```js
function round(value, decimals) {
  var factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function readU16(bytes, index) {
  return (((bytes[index] || 0) << 8) | (bytes[index + 1] || 0)) >>> 0;
}

function readI16(bytes, index) {
  var raw = readU16(bytes, index);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

function readU32(bytes, index) {
  return (
    ((bytes[index] || 0) * 0x1000000) +
    (((bytes[index + 1] || 0) << 16) >>> 0) +
    (((bytes[index + 2] || 0) << 8) >>> 0) +
    ((bytes[index + 3] || 0) >>> 0)
  ) >>> 0;
}

function decodeUplink(input) {
  var fPort = Number(input.fPort);
  if (fPort !== 10 && fPort !== 2) {
    return {
      data: {},
      warnings: [],
      errors: ['LoRain uplinks are expected on FPort 10 or legacy FPort 2']
    };
  }

  var bytes = input.bytes || [];
  var data = {};
  var warnings = [];
  var i = 0;

  function ensure(needed, label) {
    if (i + needed > bytes.length) {
      warnings.push('Truncated LoRain ' + label + ' block');
      i = bytes.length;
      return false;
    }
    return true;
  }

  while (i < bytes.length) {
    var command = bytes[i++];

    if (command === 0x03) {
      if (!ensure(3, 'hardware')) break;
      data.hw_version = bytes[i++];
      data.capabilities = readU16(bytes, i);
      i += 2;
    } else if (command === 0x04) {
      if (!ensure(3, 'configuration')) break;
      var parameter = bytes[i++];
      var parameterValue = readU16(bytes, i);
      i += 2;
      if (parameter === 0x02) data.conf_heartbeat = parameterValue;
      else if (parameter === 0x03) data.conf_heavyrain = parameterValue;
      else if (parameter === 0x04) data.conf_interval = parameterValue;
      else warnings.push('Unknown LoRain config parameter 0x' + parameter.toString(16));
    } else if (command === 0x06) {
      if (!ensure(3, 'sensor')) break;
      var sensor = bytes[i++];
      var sensorValue = readU16(bytes, i);
      i += 2;

      if (sensor === 0x81) {
        data.rainlevel = sensorValue;
        data.rain_tips_delta = sensorValue;
        data.rain_mm_delta = round(sensorValue * 0.5, 1);
      } else if (sensor === 0x01) {
        data.ambient_temperature = round(readI16(bytes, i - 2) / 10, 1);
        data.temperature_C = data.ambient_temperature;
      } else if (sensor === 0x03) {
        data.uptime_days = sensorValue;
      } else {
        warnings.push('Unknown LoRain sensor command 0x' + sensor.toString(16));
      }
    } else if (command === 0x0a) {
      if (!ensure(4, 'firmware')) break;
      data.fw_version = readU32(bytes, i);
      i += 4;
    } else if (command === 0x0b) {
      if (!ensure(4, 'alarm')) break;
      data.alarm_status = bytes[i++];
      data.alarm_type = bytes[i++];
      data.alarm_value = readU16(bytes, i);
      i += 2;
    } else if (command === 0x12) {
      if (!ensure(3, 'battery')) break;
      data.bat_v = round(bytes[i++] / 10, 1);
      data.bat_mAh = readU16(bytes, i);
      i += 2;
    } else {
      warnings.push('Unknown LoRain command 0x' + command.toString(16));
      break;
    }
  }

  return {
    data: data,
    warnings: warnings,
    errors: []
  };
}
```

- [ ] **Step 2: Copy the canonical codec to `bcm2709` for profile parity**

Run:

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js
```

- [ ] **Step 3: Run the focused codec verifier and confirm it passes**

Run:

```bash
node scripts/verify-lorain-codec.js
```

Expected: `LoRain codec verification passed`.

### Task 3: Make LoRain Ingest Accept Vendor-Style Raw `rainlevel`

**Files:**
- Modify: `scripts/verify-sync-flow.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`

- [ ] **Step 1: Add a failing flow fixture for raw vendor `rainlevel`**

In `scripts/verify-sync-flow.js`, update `buildLorainFixture()` so `rainlevel` is raw steps by default:

```js
function buildLorainFixture(options = {}) {
  const rainMmDelta = options.rainMmDelta ?? 1.5;
  const rainSteps = options.rainlevel ?? Math.round(rainMmDelta / 0.5);
  const object = {
    rain_tips_delta: options.rainTipsDelta ?? rainSteps,
    ambient_temperature: options.ambientTemperature ?? 20.5,
    bat_v: options.batV ?? 3.3,
  };
  if (options.includeRainMmDelta !== false) {
    object.rain_mm_delta = rainMmDelta;
  }
  if (options.includeRainlevel !== false) {
    object.rainlevel = rainSteps;
  }
  return {
    payload: {
      deviceInfo: {
        devEui: 'ABC123',
        deviceProfileId: options.profileId ?? 'profile-lorain',
        deviceProfileName: options.profileName ?? 'OSI Aqua-Scope LoRain',
      },
      time: options.timestamp || '2026-04-21T10:00:00.000Z',
      object,
    },
  };
}
```

Add this test next to the other LoRain fixtures:

```js
{
  const result = await runFunctionFixture('lorain-process-fn', buildLorainFixture({
    includeRainMmDelta: false,
    rainlevel: 3,
    rainTipsDelta: undefined,
  }), {
    env: { CHIRPSTACK_PROFILE_LORAIN: 'profile-lorain' },
    modules: { 'osi-db-helper': createMockOsiDb(createLorainQueryHandler({ todayTotal: 0 })) },
  });
  const persisted = result[0] && result[0].formattedData;
  expect(persisted.rainMmDelta === 1.5, 'LoRain vendor rainlevel fallback normalizes 3 steps to 1.5 mm');
  expect(persisted.rainTipsDelta === 3, 'LoRain vendor rainlevel fallback preserves raw step count as tips');
}
```

- [ ] **Step 2: Run sync verifier and confirm the new fixture fails**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: FAIL on `LoRain vendor rainlevel fallback normalizes 3 steps to 1.5 mm`.

- [ ] **Step 3: Update `Process LoRain` in canonical `flows.json`**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, update the `Process LoRain` function's rain parsing block to this logic:

```js
const object = data.object || {};
const timestamp = data.time ? new Date(data.time).toISOString() : new Date().toISOString();
const rawRainMm = object.rain_mm_delta;
const rawRainSteps = object.rainlevel;
const hasRainMm = rawRainMm != null && Number.isFinite(Number(rawRainMm));
const hasRainSteps = rawRainSteps != null && Number.isFinite(Number(rawRainSteps));
const rawTips = object.rain_tips_delta != null ? object.rain_tips_delta : (hasRainSteps ? rawRainSteps : null);
const hasRain = hasRainMm || hasRainSteps;
const rawRainMmDelta = hasRainMm
  ? roundTo(Number(rawRainMm), 1)
  : (hasRainSteps ? roundTo(Number(rawRainSteps) * 0.5, 1) : null);
```

Keep the downstream `d` object assignment, but ensure it uses `rawTips` and `rawRainMmDelta`:

```js
rainTipsDelta: rawTips != null && Number.isFinite(Number(rawTips)) ? Number(rawTips) : null,
rainMmDelta: rawRainMmDelta,
```

- [ ] **Step 4: Copy canonical flows to `bcm2709` for profile parity**

Run:

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
```

- [ ] **Step 5: Run sync verifier and confirm it passes**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: `Sync flow verification passed` and `All parity checks passed`.

### Task 4: Return Promises From The Mock SQLite `run()`

**Files:**
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add a failing mock-run promise test**

Near the existing helper fixture tests in `scripts/verify-sync-flow.js`, add:

```js
{
  const calls = [];
  const mock = createMockOsiDb(Object.assign(
    () => [],
    {
      run(sql) {
        calls.push(sql);
        return Promise.resolve();
      },
    }
  ));
  const db = new mock.Database('/tmp/test.db');
  const promise = db.run('SELECT 1');
  expect(promise && typeof promise.then === 'function', 'mock osiDb run returns a promise when no callback is supplied');
  await promise;
  expect(calls[0] === 'SELECT 1', 'mock osiDb run promise executes queryHandler.run');
}
```

Add rejection coverage:

```js
{
  const mock = createMockOsiDb(Object.assign(
    () => [],
    {
      run() {
        return Promise.reject(new Error('boom'));
      },
    }
  ));
  const db = new mock.Database('/tmp/test.db');
  let rejected = false;
  try {
    await db.run('SELECT 1');
  } catch (error) {
    rejected = String(error.message || error) === 'boom';
  }
  expect(rejected, 'mock osiDb run promise rejects when queryHandler.run rejects');
}
```

- [ ] **Step 2: Run sync verifier and confirm the new mock test fails**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: FAIL on `mock osiDb run returns a promise when no callback is supplied`.

- [ ] **Step 3: Replace `createMockOsiDb().Database.run()`**

Replace the `run(sql, params, callback)` method with:

```js
run(sql, params, callback) {
  const cb = typeof params === 'function' ? params : callback;
  const promise = Promise.resolve()
    .then(() => {
      if (typeof queryHandler.run === 'function') {
        return queryHandler.run(String(sql));
      }
      return undefined;
    })
    .then((result) => {
      if (cb) cb(null);
      return result;
    })
    .catch((error) => {
      if (cb) cb(error);
      throw error;
    });
  return promise;
}
```

- [ ] **Step 4: Run sync verifier and confirm it passes**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: `Sync flow verification passed` and `All parity checks passed`.

### Task 5: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run backend and contract verification**

Run:

```bash
node scripts/verify-lorain-codec.js
node scripts/verify-sync-flow.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-strega-gen1.js
node scripts/verify-communication-contract.js
scripts/check-mqtt-topics.sh
```

Expected:

```text
LoRain codec verification passed
Sync flow verification passed
DB schema consistency verification passed
OK Strega Gen1 smoke checks passed
Communication contract verification passed
OK: conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
```

- [ ] **Step 2: Run frontend regression verification**

Run:

```bash
cd web/react-gui && npm run test:unit && npm run build
```

Expected: unit tests pass and Vite build exits `0`. Existing Browserslist/baseline freshness warnings and the current large chunk warning are acceptable if unchanged.

- [ ] **Step 3: Run diff hygiene checks**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: `git diff --check` prints nothing. `git status` shows only the LoRain branch changes and this plan file if it has not been committed.

---

## Self-Review

**Spec coverage:** The plan covers all four findings: raw `rainlevel`, documented chained commands, `uptime_days`, and the promise-returning mock `run()`.

**Placeholder scan:** No steps use placeholder implementation language. Every code-changing step includes the exact intended code block or command.

**Type consistency:** `rainlevel` is raw step count, `rain_tips_delta` is raw step count, `rain_mm_delta` is normalized millimeters, and Node-RED `formattedData.rainMmDelta` remains normalized millimeters.
