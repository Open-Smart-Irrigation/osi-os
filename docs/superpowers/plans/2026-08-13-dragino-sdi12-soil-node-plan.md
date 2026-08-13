# Dragino SDI-12-LB/LS Soil Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `DRAGINO_SDI12` device type (Dragino SDI-12-LB/LS converter + attached soil probe) end to end: codec, probe-profile normalizer, schema, sync contract, ChirpStack provisioning, ingest flow, auto-identification, registration, and GUI.

**Architecture:** Thin codec (battery + raw ASCII only) feeding a probe-profile registry in a new `osi-sdi12-normalize` module; writes go through the existing `osi-device-writer` narrow waist. Tension probes map to existing `swt_1..3`; VWC/temp/EC probes map to 24 new `device_data` columns. Auto-identification uses the SDI-12 `aI!` command relayed via a Dragino `0xA8` downlink.

**Tech Stack:** Node-RED function nodes (edge), plain-Node helper modules tested with `node --test`, SQLite ordered migrations via `lib/osi-migrate`, React + TypeScript GUI tested with vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-dragino-sdi12-soil-node-design.md` — read it first; this plan implements it section by section.

## Global Constraints

- Base branch: `AgroLink` (work directly on it, per Phil). Checkout: `/home/phil/Repos/osi-os-agrolink`.
- `conf/full_raspberrypi_bcm27xx_bcm2712` is canonical; `bcm2709` must stay byte-identical for flows.json, node-red/, db/, and `98_osi_node_red_seed` (`node scripts/verify-profile-parity.js` gates it). The bcm2708 tree is stale — never touch it.
- Any flows.json edit: invoke the `osi-flows-json-editing` skill first. Any schema edit: invoke `osi-schema-change-control` first. Both skills live in `.claude/skills/`.
- ChirpStack profile name is exactly `OSI SDI-12 Soil Node` — it must NOT contain "Dragino" or "LSN50" (the LSN50/STREGA/telemetry dispatchers name-match on those substrings).
- Type id is exactly `DRAGINO_SDI12`. Channel keys are exactly `vwc_1..vwc_8`, `soil_temp_1..soil_temp_8`, `soil_ec_1..soil_ec_8`.
- Migration numbers are computed at execution time (`ls database/migrations/ordered/`), never hardcoded — the AgroLink lineage is past 0032.
- Never hand-edit `edge-channels.json` (generated) or `schema_object_fingerprints` (runner-owned).
- Frontend: run tests with `npx vitest run <paths>`; never run two frontend builds concurrently on this workstation (zram swap, OOM risk); reviewers must not build at all.
- Function nodes must use `osiLib.require(...)`, never bare `require` (`scripts/flows-bare-require-scan.js` gates), and must not add silent catches (`scripts/verify-no-new-silent-catch.js`).
- All NEW SQL runs through `osiDb` with bound `?` parameters (playbook L153: "bound parameters only") — the older string-building lsn50 chains are legacy, not license.
- All new prose docs must pass `node .claude/skills/anti-slop-writing/slop-check.js <file>`.

---

### Task 0: Branch preparation

**Files:**
- No source files; git state only.

**Interfaces:**
- Produces: local `AgroLink` at `origin/AgroLink` (`441c5146` or later), spec + this plan committed.

- [x] **Step 1: Stash the build residue and fast-forward AgroLink**

The checkout is on a detached HEAD (`f5ca4a1f`) with build residue under `feeds/`. Preserve it in a stash rather than discarding:

```bash
cd /home/phil/Repos/osi-os-agrolink
git stash push -u -m "feeds gui build residue (pre-sdi12)" -- feeds/
git fetch origin
git switch AgroLink
git merge --ff-only origin/AgroLink
```

If `--ff-only` fails, STOP and report — local `AgroLink` has diverged from origin and a human decision is needed.

- [x] **Step 2: Verify a clean baseline**

```bash
git status -sb   # expect: only the untracked spec + plan files
node scripts/verify-profile-parity.js && node scripts/verify-migrations.js
```

Expected: both verifiers pass on the untouched branch. If either fails, STOP — the baseline is red and nothing in this plan should proceed.

- [x] **Step 3: Commit spec and plan**

```bash
git add docs/superpowers/specs/2026-08-13-dragino-sdi12-soil-node-design.md \
        docs/superpowers/plans/2026-08-13-dragino-sdi12-soil-node-plan.md \
        docs/superpowers/plans/2026-08-13-dragino-sdi12-review-findings.md
git commit -m "docs: dragino sdi-12 soil node spec + plan (post external review)"
```

---

### Task 1: Codec

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_sdi12_decoder.js`
- Create: `scripts/verify-sdi12-codec.js`
- Modify: `scripts/verify-codec-robustness.js` (add table entry; the lsn50 entry sits near line 97)
- Modify: `.github/workflows/codecs.yml` (add a run line)

**Interfaces:**
- Produces: `decodeUplink(input) -> { data }` where FPort 2 data is `{ BatV: number, EXTI_Trigger: 'TRUE'|'FALSE', Payver: number, data_sum: string, Node_type: 'SDI12' }`; FPort 5 data is `{ SENSOR_MODEL, FIRMWARE_VERSION, FREQUENCY_BAND, SUB_BAND, BAT }`; FPort 100 data is `{ datas_sum: string }`. Field names match Dragino's official decoder so bench captures compare 1:1.

- [x] **Step 1: Write the codec**

The file is a plain script (no `module.exports`) — verifiers load it via `vm.runInNewContext`, ChirpStack uses it as `payloadCodecScript`. Model: `codecs/dragino_lsn50_decoder.js` lines 1–38 for the interface and byte helpers.

```js
// Dragino SDI-12-LB/LS uplink decoder (OSI).
// Derived from dragino/dragino-end-node-decoder SDI12_ChirpstackV4_decode.
// FPort 2: [0..1] battery mV (bit15 = EXTI flag), [2] payload version,
//          [3..] ASCII extracted from SDI-12 responses per AT+DATACUTx.
// FPort 5: device status. FPort 100: debug echo of an ad-hoc SDI-12 command.
function decodeUplink(input) {
  return { data: Decode(input.fPort, input.bytes, input.variables) };
}

function asciiFromBytes(bytes, start) {
  var out = '';
  for (var i = start; i < bytes.length; i++) {
    var b = bytes[i];
    if (b >= 0xF0) { i++; continue; }              // vendor control marker skips itself AND the next byte
    if ((b >= 0x20 && b <= 0x7E) || b === 0x0D || b === 0x0A) {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

function Decode(fPort, bytes) {
  if (!bytes || !bytes.length) return {};
  if (fPort === 5) {
    var freqBands = { 0x01: 'EU868', 0x02: 'US915', 0x03: 'IN865', 0x04: 'AU915',
      0x05: 'KZ865', 0x06: 'RU864', 0x07: 'AS923', 0x08: 'AS923-1', 0x09: 'AS923-2',
      0x0A: 'AS923-3', 0x0B: 'CN470', 0x0C: 'EU433', 0x0D: 'KR920', 0x0E: 'MA869' };
    return {
      SENSOR_MODEL: bytes[0] === 0x17 ? 'SDI12-LB/LS' : 'UNKNOWN(0x' + bytes[0].toString(16) + ')',
      FIRMWARE_VERSION: ((bytes[1] & 0x0F) + '.' + ((bytes[2] >> 4) & 0x0F) + '.' + (bytes[2] & 0x0F)),
      FREQUENCY_BAND: freqBands[bytes[3]] || ('UNKNOWN(0x' + bytes[3].toString(16) + ')'),
      SUB_BAND: bytes[4] === 0xFF ? null : bytes[4],
      BAT: ((bytes[5] << 8) | bytes[6]) / 1000
    };
  }
  if (fPort === 100) {
    return { datas_sum: asciiFromBytes(bytes, 0) };
  }
  if (fPort !== 2) {
    // FPort 3 is datalog retrieval (timestamp+length prefixed) in current
    // firmware; decoding it as periodic telemetry writes garbage. Reject
    // every port we do not explicitly support, observably.
    return { unsupported_fport: fPort };
  }
  // FPort 2: periodic sensor payload.
  if (bytes.length < 3) return {};
  var batRaw = (bytes[0] << 8) | bytes[1];
  return {
    BatV: (batRaw & 0x7FFF) / 1000,
    EXTI_Trigger: (batRaw & 0x8000) ? 'TRUE' : 'FALSE',
    Payver: bytes[2],
    data_sum: asciiFromBytes(bytes, 3),
    Node_type: 'SDI12'
  };
}
```

- [x] **Step 2: Write the failing verifier**

Model: `scripts/verify-lsn50-chameleon-codec.js` (vm load + hand-built frames + assert). Write `scripts/verify-sdi12-codec.js`:

```js
'use strict';
// Verifies codecs/dragino_sdi12_decoder.js decodes the three FPorts.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const codecPath = path.join(__dirname, '..',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_sdi12_decoder.js');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(codecPath, 'utf8'), ctx, { filename: codecPath });
assert.strictEqual(typeof ctx.decodeUplink, 'function', 'decodeUplink missing');

function ascii(s) { return Array.from(s).map((c) => c.charCodeAt(0)); }

// FPort 2: 3.300 V battery, payver 1, Tensiomark-shaped "+2.48+21.5".
const f2 = ctx.decodeUplink({ fPort: 2, bytes: [0x0C, 0xE4, 0x01].concat(ascii('+2.48+21.5')) }).data;
assert.strictEqual(f2.BatV, 3.3);
assert.strictEqual(f2.EXTI_Trigger, 'FALSE');
assert.strictEqual(f2.Payver, 1);
assert.strictEqual(f2.data_sum, '+2.48+21.5');
assert.strictEqual(f2.Node_type, 'SDI12');

// EXTI bit set: 0x8CE4 -> flag TRUE, same voltage.
const f2i = ctx.decodeUplink({ fPort: 2, bytes: [0x8C, 0xE4, 0x01].concat(ascii('+1')) }).data;
assert.strictEqual(f2i.BatV, 3.3);
assert.strictEqual(f2i.EXTI_Trigger, 'TRUE');

// FPort 5 status: model 0x17, fw 1.0.0, EU868, no sub-band, 3.005 V.
const f5 = ctx.decodeUplink({ fPort: 5, bytes: [0x17, 0x01, 0x00, 0x01, 0xFF, 0x0B, 0xBD] }).data;
assert.strictEqual(f5.SENSOR_MODEL, 'SDI12-LB/LS');
assert.strictEqual(f5.FIRMWARE_VERSION, '1.0.0');
assert.strictEqual(f5.FREQUENCY_BAND, 'EU868');
assert.strictEqual(f5.SUB_BAND, null);
assert.strictEqual(f5.BAT, 3.005);

// FPort 100 debug echo, including the vendor NULL marker.
const f100 = ctx.decodeUplink({ fPort: 100, bytes: ascii('013SENTEK  ES2   101') }).data;
assert.strictEqual(f100.datas_sum, '013SENTEK  ES2   101');
const fnull = ctx.decodeUplink({ fPort: 100, bytes: [0x4E, 0x55, 0x4C, 0x4C] }).data;
assert.strictEqual(fnull.datas_sum, 'NULL');

// Unsupported ports (incl. FPort 3 datalog) must be rejected, not decoded.
const f3 = ctx.decodeUplink({ fPort: 3, bytes: [0x66, 0x9F, 0x01, 0x02, 0x03] }).data;
assert.strictEqual(f3.unsupported_fport, 3);
assert.strictEqual(f3.data_sum, undefined);
const f7 = ctx.decodeUplink({ fPort: 7, bytes: ascii('+1.0') }).data;
assert.strictEqual(f7.unsupported_fport, 7);

// A control byte >= 0xF0 skips itself AND the following (printable) byte.
const fctl = ctx.decodeUplink({ fPort: 2, bytes: [0x0C, 0xE4, 0x01, 0xF4, 0x31].concat(ascii('+2.5')) }).data;
assert.strictEqual(fctl.data_sum, '+2.5');   // the '1' (0x31) after 0xF4 must not leak into the data

// Short/garbage frames must not throw.
ctx.decodeUplink({ fPort: 2, bytes: [] });
ctx.decodeUplink({ fPort: 2, bytes: [0x01] });
console.log('verify-sdi12-codec: PASS');
```

- [x] **Step 3: Run to verify current failure, then create the codec file and re-run**

```bash
node scripts/verify-sdi12-codec.js   # first run: fails (codec file absent)
# create the codec file from Step 1, then:
node scripts/verify-sdi12-codec.js   # expect: verify-sdi12-codec: PASS
```

- [x] **Step 4: Register in robustness + CI**

In `scripts/verify-codec-robustness.js`, copy the lsn50 table entry shape and add one for `dragino_sdi12_decoder.js`. In `.github/workflows/codecs.yml`, after the `verify-s2120-codec.js` line add:

```yaml
      - run: node scripts/verify-sdi12-codec.js
```

Run: `node scripts/verify-codec-robustness.js` — expect PASS including the sdi12 entry.

- [x] **Step 5: Mirror to bcm2709 and commit**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_sdi12_decoder.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/codecs/dragino_sdi12_decoder.js
node scripts/verify-profile-parity.js
git add -A && git commit -m "feat(sdi12): dragino sdi-12 codec + verifier"
```

---

### Task 2: `osi-sdi12-normalize` module

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.test.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/package.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js` (`NAME_TO_PATH`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json` + `package-lock.json` (module entry, both profiles — see registration step)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed` (module copy loop, near lines 30–33)
- Modify: `deploy.sh` (two `fetch_required` lines near the LSN50 codec fetch at ~583)

**Interfaces:**
- Consumes: decoded object from Task 1 (`{ BatV, Payver, data_sum }`).
- Produces (later tasks call these exact names):
  - `normalize(decoded, deviceConfig, meta) -> { channels, unknown, recordedAt, noResponse }` — `deviceConfig = { probeProfile: string|null }`, `meta = { recordedAt }`; `channels` keyed by manifest channel keys (`bat_v`, `vwc_N`, `soil_temp_N`, `soil_ec_N`, `swt_N`).
  - `parseSdi12Values(str) -> number[] | null` (null = not a pure sign-delimited value string).
  - `parseIdentity(identityString) -> { vendor, model, firmware } | null` (for storing/displaying the aI! response even when nothing matches).
  - `matchProfile(identityString, profiles?) -> { profileId, vendor, model, firmware } | null` — with v1's all-null matchers this returns null for every shipped profile; the optional `profiles` param exists for tests and for bench-enabled matchers.
  - `listProfiles() -> [{ id, label, provisional, expectedValues, defaultDepthsCm, channels, depthSlots }]`
  - `getProfile(id) -> profile | null`
  - `worstCaseUplinkBytes(profile) -> number` (3 header bytes + 7 per value; budget-tested ≤ 51).

- [x] **Step 1: Write the failing tests**

`index.test.js` (run with `node --test`; model the style of `osi-uc512-normalize`'s sibling tests):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('./index.js');

test('parseSdi12Values: strict grammar', () => {
  assert.deepStrictEqual(m.parseSdi12Values('+2.48+21.5'), [2.48, 21.5]);
  assert.deepStrictEqual(m.parseSdi12Values('-0.5+7'), [-0.5, 7]);
  assert.strictEqual(m.parseSdi12Values('0+30.5+22.1'), null);      // leading address char
  assert.strictEqual(m.parseSdi12Values('+22.10+31.2x'), null);     // trailing garbage
  assert.strictEqual(m.parseSdi12Values('NULL'), null);
  assert.strictEqual(m.parseSdi12Values(''), null);
});

test('transforms: pf_to_kpa and hpa_to_kpa with swt clamp', () => {
  const r = m.normalize({ BatV: 3.3, data_sum: '+2.48+21.5' }, { probeProfile: 'TENSIOMARK' }, {});
  assert.strictEqual(r.channels.swt_1, 30.2);        // 10^2.48/10 rounded to 2dp
  assert.strictEqual(r.channels.soil_temp_1, 21.5);
  assert.strictEqual(r.channels.bat_v, 3.3);
  const dry = m.normalize({ BatV: 3.3, data_sum: '+7.0+21.5' }, { probeProfile: 'TENSIOMARK' }, {});
  assert.strictEqual(dry.channels.swt_1, 300);       // pF 7 clamps to 300 kPa
});

test('exact cardinality rejects the frame atomically', () => {
  // TENSIOMARK expects exactly 2 values: 1 or 3 must write NOTHING but battery.
  for (const raw of ['+2.48', '+2.48+21.5+9.9']) {
    const r = m.normalize({ BatV: 3.3, data_sum: raw }, { probeProfile: 'TENSIOMARK' }, {});
    assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
    assert.strictEqual(r.unknown.sdi12_value_count, raw);
  }
});

test('GENERIC_VWC (variable count, documented escape hatch) maps in order and bounds-checks', () => {
  const r = m.normalize({ BatV: 3.0, data_sum: '+30.5+28.1+25.9' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.deepStrictEqual(
    [r.channels.vwc_1, r.channels.vwc_2, r.channels.vwc_3],
    [30.5, 28.1, 25.9]);
  assert.strictEqual(r.channels.vwc_4, undefined);   // only 3 values present
  const bad = m.normalize({ BatV: 3.0, data_sum: '+250.0' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.strictEqual(bad.channels.vwc_1, undefined); // out of [0,100]
  assert.ok(Object.keys(bad.unknown).some((k) => k.startsWith('vwc_1')));
});

test('no profile -> battery only + quarantine marker', () => {
  const r = m.normalize({ BatV: 3.1, data_sum: '+1.0' }, { probeProfile: null }, {});
  assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
  assert.ok(r.unknown.sdi12_unconfigured);
});

test('NULL is matched exactly, never by substring', () => {
  const r = m.normalize({ BatV: 3.1, data_sum: 'NULL' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.strictEqual(r.noResponse, true);
  assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
  assert.deepStrictEqual(r.unknown, {});
  // Embedded NULL is garbage, not a no-response frame.
  const g = m.normalize({ BatV: 3.1, data_sum: '+1NULL' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.strictEqual(g.noResponse, false);
  assert.ok(g.unknown.unparseable_sdi12);
});

test('unparseable non-NULL -> quarantine marker', () => {
  const r = m.normalize({ BatV: 3.1, data_sum: '0+30.5' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
  assert.ok(r.unknown.unparseable_sdi12);
});

test('parseIdentity extracts vendor/model/firmware for storage and display', () => {
  const id = m.parseIdentity('013SENTEK  ES2   101serial');
  assert.strictEqual(id.vendor.trim(), 'SENTEK');
  assert.strictEqual(id.model.trim(), 'ES2');
  assert.strictEqual(id.firmware, '101');
  assert.strictEqual(m.parseIdentity('NULL'), null);   // too short / not an identity
});

test('v1 ships no auto-matchers; matchProfile works only with bench-enabled patterns', () => {
  // Every shipped profile is provisional with identityMatch null:
  assert.strictEqual(m.matchProfile('013SENTEK  ES2   101serial'), null);
  // The matcher machinery itself works when a bench-verified pattern exists:
  const benchProfiles = [{ id: 'X', identityMatch: /SENTEK/i }];
  const hit = m.matchProfile('013SENTEK  ES2   101serial', benchProfiles);
  assert.strictEqual(hit.profileId, 'X');
});

test('every fixed-cardinality profile fits the 51-byte DR0 uplink budget', () => {
  for (const p of m.PROFILES) {
    if (p.expectedValues == null) continue;          // GENERIC_VWC: variable, documented risk
    assert.ok(m.worstCaseUplinkBytes(p) <= 51,
      p.id + ' exceeds DR0 budget: ' + m.worstCaseUplinkBytes(p));
  }
});

test('listProfiles is GUI-serializable and slot-aware', () => {
  const list = m.listProfiles();
  assert.ok(list.length >= 7);
  for (const p of list) {
    assert.strictEqual(typeof p.id, 'string');
    assert.strictEqual(typeof p.label, 'string');
    assert.strictEqual(typeof p.provisional, 'boolean');
    assert.ok(Array.isArray(p.channels));
    assert.ok(Array.isArray(p.depthSlots));
    JSON.stringify(p); // must not throw (no RegExp leakage)
  }
  const tensio = list.find((p) => p.id === 'TENSIOMARK');
  assert.deepStrictEqual(tensio.depthSlots, [1]);    // 2 channels, 1 physical depth
});
```

- [x] **Step 2: Run tests to verify they fail**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize && node --test
```

Expected: FAIL — `Cannot find module './index.js'`.

- [x] **Step 3: Write the module**

`index.js`:

```js
'use strict';
// osi-sdi12-normalize — probe-profile parsing for the Dragino SDI-12-LB/LS.
// Spec: docs/superpowers/specs/2026-08-13-dragino-sdi12-soil-node-design.md.
// Profiles are data: adding/correcting a probe is a registry edit + a test
// fixture, never an architecture change. Profiles marked provisional:true
// are datasheet-derived hypotheses awaiting bench capture.

var VALUE_RE = /^([+-]\d+(?:\.\d+)?)+$/;
var EXTRACT_RE = /[+-]\d+(?:\.\d+)?/g;

var TRANSFORMS = {
  pf_to_kpa: function (v) { return Math.pow(10, v) / 10; },
  hpa_to_kpa: function (v) { return v / 10; }
};

// Budget: 3 header bytes + worst-case 7 ASCII chars per value (sign + 6).
// Dragino delivers at most 51 bytes per FPort 2 uplink at DR0; oversized
// frames are dropped by the device. Fixed-cardinality profiles must fit.
var UPLINK_HEADER_BYTES = 3;
var WORST_CHARS_PER_VALUE = 7;

function worstCaseUplinkBytes(profile) {
  var n = profile.expectedValues == null ? profile.values.length : profile.expectedValues;
  return UPLINK_HEADER_BYTES + n * WORST_CHARS_PER_VALUE;
}

function seq(prefix, n, opts) {
  var out = [];
  var startIndex = (opts && opts.startIndex) || 0;
  for (var i = 0; i < n; i++) {
    out.push({ index: startIndex + i, channel: prefix + '_' + (i + 1), depthSlot: i + 1 });
  }
  return out;
}

// ALL named profiles ship provisional with identityMatch:null — matchers are
// enabled per probe at the bench, only for identities that uniquely
// determine a value layout (PR2/4 vs PR2/6 share an identity: manual forever).
var PROFILES = [
  {
    id: 'GENERIC_VWC',
    label: 'Generic SDI-12 (VWC per value, in order)',
    provisional: false,
    identityMatch: null,
    expectedValues: null,               // variable: the documented escape hatch
    values: seq('vwc', 8),
    defaultDepthsCm: []
  },
  {
    id: 'SENTEK_ENVIROSCAN',
    label: 'Sentek EnviroSCAN (VWC, up to 6 depths in v1)',
    provisional: true,
    identityMatch: null,
    expectedValues: 6,                  // 8 depths needs AT+DATAUP=1 (phase 2): 8*7+3 > 51-byte DR0 budget
    values: seq('vwc', 6),
    defaultDepthsCm: [10, 20, 30, 40, 50, 60]
  },
  {
    id: 'DELTAT_PR2_4',
    label: 'Delta-T PR2/4 (VWC, 4 depths)',
    provisional: true,
    identityMatch: null,
    expectedValues: 4,
    values: seq('vwc', 4),
    defaultDepthsCm: [10, 20, 30, 40]
  },
  {
    id: 'DELTAT_PR2_6',
    label: 'Delta-T PR2/6 (VWC, 6 depths)',
    provisional: true,
    identityMatch: null,
    expectedValues: 6,
    values: seq('vwc', 6),
    defaultDepthsCm: [10, 20, 30, 40, 60, 100]
  },
  {
    id: 'TENSIOMARK',
    label: 'ecoTech Tensiomark (tension pF + temp)',
    provisional: true,
    identityMatch: null,
    expectedValues: 2,
    values: [
      { index: 0, channel: 'swt_1', transform: 'pf_to_kpa', depthSlot: 1 },
      { index: 1, channel: 'soil_temp_1', depthSlot: 1 }
    ],
    defaultDepthsCm: [30]
  },
  {
    id: 'IMKO_PICO64',
    label: 'IMKO TRIME PICO 64 (VWC + temp)',
    provisional: true,
    identityMatch: null,
    expectedValues: 2,
    values: [
      { index: 0, channel: 'vwc_1', depthSlot: 1 },
      { index: 1, channel: 'soil_temp_1', depthSlot: 1 }
    ],
    defaultDepthsCm: [30]
  },
  {
    id: 'HYDRASCOUT',
    label: 'HydraScout (VWC + temp + EC, 2 depths in v1)',
    provisional: true,
    identityMatch: null,
    expectedValues: 6,                  // more depths needs AT+DATAUP=1 (phase 2)
    // PROVISIONAL interleave (per-depth vwc,temp,ec) - bench capture decides.
    values: [
      { index: 0, channel: 'vwc_1', depthSlot: 1 },
      { index: 1, channel: 'soil_temp_1', depthSlot: 1 },
      { index: 2, channel: 'soil_ec_1', depthSlot: 1 },
      { index: 3, channel: 'vwc_2', depthSlot: 2 },
      { index: 4, channel: 'soil_temp_2', depthSlot: 2 },
      { index: 5, channel: 'soil_ec_2', depthSlot: 2 }
    ],
    defaultDepthsCm: [15, 30]
  }
];

var BOUNDS = {
  vwc: { min: 0, max: 100 },
  soil_temp: { min: -30, max: 70 },
  soil_ec: { min: 0, max: 100000 }
};

function channelFamily(channel) {
  return channel.replace(/_\d+$/, '');
}

function parseSdi12Values(str) {
  if (typeof str !== 'string' || !VALUE_RE.test(str)) return null;
  var out = [];
  var match = str.match(EXTRACT_RE);
  for (var i = 0; i < match.length; i++) out.push(parseFloat(match[i]));
  return out;
}

function getProfile(id) {
  for (var i = 0; i < PROFILES.length; i++) {
    if (PROFILES[i].id === id) return PROFILES[i];
  }
  return null;
}

function listProfiles() {
  return PROFILES.map(function (p) {
    var slots = [];
    p.values.forEach(function (v) {
      if (v.depthSlot && slots.indexOf(v.depthSlot) === -1) slots.push(v.depthSlot);
    });
    slots.sort(function (a, b) { return a - b; });
    return {
      id: p.id,
      label: p.label,
      provisional: p.provisional,
      expectedValues: p.expectedValues,
      defaultDepthsCm: p.defaultDepthsCm.slice(),
      channels: p.values.map(function (v) { return v.channel; }),
      depthSlots: slots
    };
  });
}

// aI! response: address(1) + sdi12 version(2) + vendor(8) + model(6) + fw(3) + rest.
function parseIdentity(identityString) {
  if (typeof identityString !== 'string' || identityString.length < 17) return null;
  return {
    vendor: identityString.slice(3, 11),
    model: identityString.slice(11, 17),
    firmware: identityString.slice(17, 20)
  };
}

function matchProfile(identityString, profiles) {
  var id = parseIdentity(identityString);
  if (!id) return null;
  var haystack = id.vendor + ' ' + id.model;
  var list = profiles || PROFILES;
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (p.identityMatch && p.identityMatch.test(haystack)) {
      return { profileId: p.id, vendor: id.vendor, model: id.model, firmware: id.firmware };
    }
  }
  return null;
}

function applyValue(entry, raw) {
  var v = raw;
  if (entry.transform) {
    var fn = TRANSFORMS[entry.transform];
    if (!fn) return { error: 'unknown_transform:' + entry.transform };
    v = fn(v);
  }
  if (typeof entry.scale === 'number') v = v * entry.scale;
  if (typeof entry.offset === 'number') v = v + entry.offset;
  var family = channelFamily(entry.channel);
  if (family === 'swt') {
    // Clamp like resistanceOhmsToKpa (osi-chameleon-helper): [0,300], 2dp.
    v = Math.min(300, Math.max(0, v));
    return { value: Math.round(v * 100) / 100 };
  }
  var bounds = BOUNDS[family];
  if (bounds && (v < bounds.min || v > bounds.max)) {
    return { error: 'out_of_range' };
  }
  return { value: Math.round(v * 100) / 100 };
}

function normalize(decoded, deviceConfig, meta) {
  var channels = {};
  var unknown = {};
  var noResponse = false;
  var raw = decoded && typeof decoded.data_sum === 'string' ? decoded.data_sum.trim() : '';

  if (decoded && typeof decoded.BatV === 'number') channels.bat_v = decoded.BatV;

  var profileId = deviceConfig && deviceConfig.probeProfile;
  var profile = profileId ? getProfile(profileId) : null;

  if (raw === 'NULL') {
    // Exact match only: probe did not answer. Alive node, no data,
    // never fabricate values. An embedded NULL is garbage, handled below.
    noResponse = true;
  } else if (!profile) {
    unknown.sdi12_unconfigured = raw || '(empty)';
  } else {
    var values = parseSdi12Values(raw);
    if (values === null) {
      unknown.unparseable_sdi12 = raw || '(empty)';
    } else if (profile.expectedValues != null && values.length !== profile.expectedValues) {
      // Cardinality mismatch rejects the frame atomically: a glued address
      // digit or truncated response must never produce a partial write.
      unknown.sdi12_value_count = raw;
    } else {
      for (var i = 0; i < profile.values.length; i++) {
        var entry = profile.values[i];
        if (entry.index >= values.length) continue;
        var res = applyValue(entry, values[entry.index]);
        if (res.error) {
          unknown[entry.channel + ':' + res.error] = values[entry.index];
        } else {
          channels[entry.channel] = res.value;
        }
      }
    }
  }

  return {
    channels: channels,
    unknown: unknown,
    recordedAt: (meta && meta.recordedAt) || null,
    noResponse: noResponse
  };
}

module.exports = {
  normalize: normalize,
  parseSdi12Values: parseSdi12Values,
  parseIdentity: parseIdentity,
  matchProfile: matchProfile,
  listProfiles: listProfiles,
  getProfile: getProfile,
  worstCaseUplinkBytes: worstCaseUplinkBytes,
  TRANSFORMS: TRANSFORMS,
  PROFILES: PROFILES
};
```

`package.json` (copy `osi-uc512-normalize/package.json` and change the name to `osi-sdi12-normalize`).

- [x] **Step 4: Run tests to verify they pass**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize && node --test
```

Expected: all tests PASS. (The 30.2 assertion holds: `10^2.48 / 10 = 30.199…` → 30.2 at 2 dp.)

- [x] **Step 5: Three-surface registration**

Follow `scripts/verify-helper-registration.js`'s rules exactly; use `osi-uc512-normalize` as the reference for each surface:

1. `osi-lib/index.js` `NAME_TO_PATH`: add `'sdi12-normalize': 'osi-sdi12-normalize',` after the `lsn50-normalize` line.
2. `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json` and `package-lock.json`: add the module the same way `osi-uc512-normalize` is present (grep for it to see the exact form), then mirror both files in the bcm2709 profile.
3. `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed`: add `osi-sdi12-normalize` to the module copy loop.
4. `deploy.sh`: next to the LSN50 codec `fetch_required` lines (~583), add fetches for `codecs/dragino_sdi12_decoder.js` and the `osi-sdi12-normalize` module files, matching the existing style for `osi-uc512-normalize`.

- [x] **Step 6: Verify registration + parity, copy module to bcm2709, commit**

```bash
cp -r conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/
node scripts/verify-helper-registration.js
node scripts/verify-profile-parity.js
git add -A && git commit -m "feat(sdi12): probe-profile normalize module with registry + transforms"
```

---

### Task 3: Channel manifest (24 new channels)

**Files:**
- Modify: `web/react-gui/src/channels/channels.json` (canonical)
- Modify: `docs/channel-manifest.md` (recorded SHA-256, last line)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm{2712,2709}/files/usr/share/node-red/edge-channels.json` (generated only)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm{2712,2709}/files/usr/share/node-red/osi-history-helper/index.js` (channel list — find the existing `swt_1` entry and mirror its structure)

**Interfaces:**
- Produces: channel keys `vwc_1..8`, `soil_temp_1..8`, `soil_ec_1..8`, each with `edgeField` equal to the key. Tasks 4, 9, 13, 15 rely on these exact keys.

- [x] **Step 1: Generate the 24 entries**

Read one existing soil entry in `channels.json` (e.g. `swt_1`) to confirm the field set, then run this once from the repo root (adjust only if the entry shape differs):

```bash
node -e '
const fs = require("fs");
const p = "web/react-gui/src/channels/channels.json";
const arr = JSON.parse(fs.readFileSync(p, "utf8"));
const mk = (key, unit, label, displayName) => ({
  key, unit, label, displayName,
  cardType: "soil", category: "soil",
  edgeField: key, serverField: key,
  exportable: true, deprecated: false, legacyAliases: []
});
for (let i = 1; i <= 8; i++) arr.push(mk(`vwc_${i}`, "%", `VWC ${i}`, `Volumetric water content (depth ${i})`));
for (let i = 1; i <= 8; i++) arr.push(mk(`soil_temp_${i}`, "°C", `Soil temp ${i}`, `Soil temperature (depth ${i})`));
for (let i = 1; i <= 8; i++) arr.push(mk(`soil_ec_${i}`, "µS/cm", `Soil EC ${i}`, `Soil electrical conductivity (depth ${i})`));
fs.writeFileSync(p, JSON.stringify(arr, null, 2) + "\n");
console.log("entries now:", arr.length);
'
```

- [x] **Step 2: Regenerate the edge manifest and record the new SHA**

```bash
node scripts/build-edge-manifest.js
sha256sum web/react-gui/src/channels/channels.json
```

Replace the recorded SHA-256 at the end of `docs/channel-manifest.md` with the new value.

- [x] **Step 3: Extend osi-history-helper's channel list**

`verify-channel-manifest-parity.js` asserts channels.json against `osi-history-helper/index.js` in both profiles. Grep the helper for `swt_1`, add the 24 new channels in the same structure, and mirror the file to bcm2709.

- [x] **Step 4: Run the gates**

```bash
node scripts/verify-channel-manifest-parity.js
cd web/react-gui && npx vitest run src/channels/__tests__/channels.test.ts && cd ../..
node scripts/verify-profile-parity.js
```

Expected: all PASS. (`verify-db-schema-consistency` will fail until Task 5 adds the columns — that is expected and is why this task does not run it.)

- [x] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(sdi12): vwc/soil_temp/soil_ec channel manifest entries (8 depths)"
```

---

### Task 4: Atomic schema slice — one task, one commit

> Parts A–C below (formerly Tasks 4–6) are ONE unit of work executed by ONE
> agent and landed as ONE commit: migration + seed + boot-node literals +
> repair script + telemetry trigger + all seven bundled DBs must never be
> split across commits (spec §Schema; `osi-schema-change-control`).

#### Part A: additive migration (device_data + devices columns)

**Files:**
- Create: `database/migrations/ordered/NNNN__sdi12_columns.sql` (compute NNNN below)
- Modify: `database/seed-blank.sql` (devices CREATE ~L94-140, device_data CREATE ~L171-231)
- Modify: `database/migrations/ordered/CHECKSUMS.json`

**Interfaces:**
- Produces: 24 `device_data` REAL columns named exactly like the channel keys; `devices.sdi12_probe_profile TEXT`, `devices.sdi12_probe_status TEXT`, `devices.sdi12_identity TEXT`.

Invoke the `osi-schema-change-control` skill before this task and follow its checklist alongside these steps.

- [ ] **Step 1: Compute the next migration number**

```bash
NEXT=$(printf "%04d" $(( 10#$(ls database/migrations/ordered/ | grep -oE '^[0-9]{4}' | sort -n | tail -1) + 1 )))
echo "$NEXT"
```

- [ ] **Step 2: Write the migration**

`database/migrations/ordered/${NEXT}__sdi12_columns.sql` (model: `0012__uc512_device_data_columns.sql`):

```sql
-- risk: additive
-- NNNN: DRAGINO_SDI12 telemetry + device-config columns.
-- 8-depth VWC / soil temperature / soil EC (spec 2026-08-13), plus the
-- per-device probe profile, identify status, and raw aI! identity string.

ALTER TABLE device_data ADD COLUMN vwc_1 REAL;
ALTER TABLE device_data ADD COLUMN vwc_2 REAL;
ALTER TABLE device_data ADD COLUMN vwc_3 REAL;
ALTER TABLE device_data ADD COLUMN vwc_4 REAL;
ALTER TABLE device_data ADD COLUMN vwc_5 REAL;
ALTER TABLE device_data ADD COLUMN vwc_6 REAL;
ALTER TABLE device_data ADD COLUMN vwc_7 REAL;
ALTER TABLE device_data ADD COLUMN vwc_8 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_1 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_2 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_3 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_4 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_5 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_6 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_7 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_8 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_1 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_2 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_3 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_4 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_5 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_6 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_7 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_8 REAL;
ALTER TABLE devices ADD COLUMN sdi12_probe_profile TEXT;
ALTER TABLE devices ADD COLUMN sdi12_probe_status TEXT
  CHECK(sdi12_probe_status IN ('pending_identify','identified','unmatched','manual'));
ALTER TABLE devices ADD COLUMN sdi12_identity TEXT;
```

Replace `NNNN` in the comment with the computed number.

- [ ] **Step 3: Mirror in seed-blank.sql**

Append the same 24 columns to the `device_data` CREATE TABLE and the 3 columns (with the same CHECK) to the `devices` CREATE TABLE in `database/seed-blank.sql`, placed last in each column list so the migration replay matches.

- [ ] **Step 4: Update CHECKSUMS.json and run the migration gates**

```bash
node scripts/verify-migrations.js       # on checksum mismatch it reports the expected value; update CHECKSUMS.json to match
node scripts/verify-migrations.js       # expect PASS
node scripts/verify-seed-replay.js      # replay of all ordered migrations must equal seed-blank.sql
```

No commit yet — continue directly to Part B.

#### Part B: destructive migration, boot-node literals, repair script, telemetry trigger

**Files:**
- Create: `database/migrations/ordered/MMMM__add_dragino_sdi12_type.sql` (MMMM = NEXT+1)
- Modify: `database/seed-blank.sql` (type_id CHECK ~L98-101; `trg_sync_devices_outbox_au` WHEN + payload; `trg_dp_device_data_outbox_ai` payload ~L1408)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm{2712,2709}/files/usr/share/flows.json` — the `sync-init-fn` node's THREE devices literals (`REQUIRED_TYPES`, `DEVICES_NEW_DDL`, `DEVICES_COPY_SQL`, all at flows:5792) plus its copy of the `trg_dp_device_data_outbox_ai` body
- Modify: `scripts/repair-pi-schema.js` (`ensureDeviceTypeCheckIncludesLorain`'s hardcoded `deviceColumns` list + CHECK, ~L232)
- Modify: `scripts/rehearse-devices-rebuild.test.js` (sentinel `sdi12_*` preservation case)

**Interfaces:**
- Produces: `DRAGINO_SDI12` accepted by `devices.type_id`; `sdi12_probe_profile` in the device sync payload.

Invoke `osi-schema-change-control` (this is its four-verifier merge-gate case) and `osi-flows-json-editing` for the flows edit.

- [ ] **Step 1: Write the rebuild migration**

Copy `database/migrations/ordered/0010__add_milesight_uc512_type.sql` as the structural template, but derive the `CREATE TABLE devices (...)` column list and both trigger texts **from the current `database/seed-blank.sql` on this branch** — NOT from 0010's literal (the branch has grown columns since, including Task 4's three). The deltas versus current seed are exactly:

1. In the CHECK list, `'MILESIGHT_UC512')` becomes `'MILESIGHT_UC512','DRAGINO_SDI12')` (same change in seed-blank.sql).
2. The `INSERT INTO devices (...) SELECT ... FROM devices_old` lists every column explicitly, in the CREATE order (include the three `sdi12_*` columns).
3. In `trg_sync_devices_outbox_au`, add to the WHEN disjunction:

```sql
    COALESCE(NEW.sdi12_probe_profile,'') <> COALESCE(OLD.sdi12_probe_profile,'') OR
```

and to the `json_object(...)` payload (after the `'strega_model'` pair):

```sql
      'sdi12_probe_profile',               NEW.sdi12_probe_profile,
```

4. Apply the same trigger changes to `seed-blank.sql` so migration text and seed text stay identical.
5. Extend `trg_dp_device_data_outbox_ai` (the device_data → sync_outbox
   trigger, seed ~L1408): its `json_object` payload enumerates every
   telemetry field, so add all 24 new fields
   (`'vwc_1', NEW.vwc_1, … 'soil_ec_8', NEW.soil_ec_8`) after the existing
   telemetry pairs — in the seed, in this migration (drop/recreate the
   trigger with the extended body), and in the boot-node copy (Step 2).
   Without this, no SDI-12 reading ever rides `DEVICE_DATA_APPENDED`.

Header: `-- risk: destructive`, plus the 0010-style comment block explaining the rebuild.

- [ ] **Step 2: Update ALL the boot-node literals in both flows files**

The `sync-init-fn` node ("Sync Init Schema + Triggers", flows:5792) embeds
three devices literals; updating only the type list makes a live rebuild
recreate `devices` WITHOUT the sdi12 columns and with a stale CHECK that
re-triggers the rebuild every boot. Change all three, plus the trigger copy:

1. `REQUIRED_TYPES = ['KIWI_SENSOR',…,'MILESIGHT_UC512']` → append `'DRAGINO_SDI12'`.
2. `DEVICES_NEW_DDL` — a full `CREATE TABLE IF NOT EXISTS devices_new (…)`
   string: extend its CHECK with `'DRAGINO_SDI12'` and append the three
   `sdi12_*` column definitions (matching the seed text exactly, including
   the status CHECK).
3. `DEVICES_COPY_SQL` — the positional `INSERT INTO devices_new (…) SELECT …
   FROM devices` string: append the three `sdi12_*` columns to both lists in
   the same order as the DDL.
4. The node's embedded `trg_dp_device_data_outbox_ai` body: apply the same
   24-field payload extension as Step 1 item 5, byte-identical to the seed
   (gated by `verify-trigger-body-parity.js`).

Then `cp` flows.json to the bcm2709 profile.

- [ ] **Step 3: Extend the repair script**

`scripts/repair-pi-schema.js` (`ensureDeviceTypeCheckIncludesLorain`, ~L232)
carries its own hardcoded `deviceColumns` list and CHECK for a devices
rebuild on live Pis: add `'DRAGINO_SDI12'` to its CHECK text and the three
`sdi12_*` columns to `deviceColumns`, following how the chameleon columns
appear there.

- [ ] **Step 4: Extend the rebuild rehearsal with sdi12 sentinels**

In `scripts/rehearse-devices-rebuild.test.js`, add a case that seeds a
device row with sentinel values (`sdi12_probe_profile='SENTINEL_P'`,
`sdi12_probe_status='manual'`, `sdi12_identity='SENTINEL_I'`), executes the
shipped `sync-init-fn` rebuild text, and asserts the sentinels survive and
`PRAGMA table_info(devices)` contains all three columns — the existing
verifiers compare type sets and fencing, not column preservation.

- [ ] **Step 5: Run the extended merge gate**

```bash
node scripts/verify-migrations.js            # update CHECKSUMS.json as in Part A
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/test-flows-wiring.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
```

Expected: all PASS. `verify-runtime-schema-parity` derives the canonical type
set from seed-blank.sql, so a REQUIRED_TYPES/seed mismatch fails loudly;
`verify-trigger-body-parity` catches a seed/boot-node trigger divergence.

No commit yet — continue directly to Part C.

#### Part C: bundled DBs + schema-consistency contract + the atomic commit

**Files:**
- Modify: `scripts/verify-db-schema-consistency.js` (`schemaContract` — the hand-maintained list; `adc_ch1v` appears near lines 105/129/158 as a reference)
- Regenerate: all 7 bundled `farming.db` copies (base_2709, base_2712, full_2708, full_2709, full_2712, `database/farming.db`, `web/react-gui/farming.db`)

**Interfaces:**
- Consumes: Tasks 4–5 schema.

- [ ] **Step 1: Extend schemaContract**

Add the 24 `device_data` columns and 3 `devices` columns wherever `schemaContract` enumerates those tables (follow how the UC512 columns were added — `git log -p --follow scripts/verify-db-schema-consistency.js` shows the 0012-era commit).

- [ ] **Step 2: Regenerate the 7 bundled DBs**

Follow the recipe in `.claude/skills/osi-schema-change-control/SKILL.md` section on regenerating bundled DBs (SKILL.md ~L493-506) — all seven in this one commit.

- [ ] **Step 3: Run the schema battery**

```bash
node scripts/verify-db-schema-consistency.js
node scripts/verify-seed-replay.js
node scripts/verify-profile-parity.js
# test-journal-schema.js is on the schema-change-control checklist for this
# branch: run it and FAIL on failure — never mask with || true.
test -f scripts/test-journal-schema.js && node scripts/test-journal-schema.js
```

Expected: PASS.

- [ ] **Step 4: The single atomic commit for the whole schema slice (Parts A+B+C)**

```bash
git add -A && git commit -m "feat(sdi12): atomic schema slice - columns, type CHECK, boot literals, triggers, repair, bundled DBs"
```

---

### Task 5: (merged into Task 4 Part B)

### Task 6: (merged into Task 4 Part C)

---

### Task 7: Sync contract schema

**Files:**
- Modify: `docs/contracts/sync-schema/resources.schema.json` (Device definition, ~L57-80)

**Interfaces:**
- Produces: `DRAGINO_SDI12` in the `Device.type_id` enum; `sdi12_probe_profile` property.

- [ ] **Step 1: Edit the schema**

In the `Device` definition: append `"DRAGINO_SDI12"` to the `type_id` enum, and add alongside the `chameleon_enabled`-style properties:

```json
"sdi12_probe_profile": { "type": ["string", "null"] }
```

Match the surrounding property style exactly (read the neighbors first).

- [ ] **Step 2: Run the contract gate and commit**

```bash
node scripts/verify-sync-contract.js
git add -A && git commit -m "feat(sdi12): DRAGINO_SDI12 in sync resources schema"
```

Note in the commit body that osi-server needs the mirrored enum + channel copies (lockstep companion work, out of this plan's scope).

---

### Task 8: ChirpStack provisioning

**Files:**
- Modify: `scripts/chirpstack-bootstrap.js` AND `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js` (two byte-identical copies — edit one, `cp` to the other, `diff` to confirm)
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` (UCI→env resolution ~L94 area + export block ~L230 area)

**Interfaces:**
- Produces: env/UCI keys `CHIRPSTACK_PROFILE_SDI12` / `chirpstack_profile_sdi12`; ChirpStack device profile named `OSI SDI-12 Soil Node` with the codec uploaded; the env var resolvable from UCI alone on env-file-less boots.

- [ ] **Step 1: Add the six wiring points**

Follow the LSN50 wiring at the explore-verified line anchors (conf copy: 37, 43, 89, 95, 299, 439, 447-448, 472, 499):

1. Header doc comments: `CS_PROFILE_SDI12_NAME` (default `"OSI SDI-12 Soil Node"`) and `SDI12_CODEC_PATH`.
2. `CFG`: `profileSdi12Name: process.env.CS_PROFILE_SDI12_NAME || 'OSI SDI-12 Soil Node',` and `sdi12CodecPath: process.env.SDI12_CODEC_PATH || '/srv/node-red/codecs/dragino_sdi12_decoder.js',`.
3. `toUciCloudKey`: `CHIRPSTACK_PROFILE_SDI12: 'chirpstack_profile_sdi12',`.
4. App assignment: SDI12 into `CFG.appSensorsName`.
5. In step `[4/5]`: `const sdi12Script = readCodecScript(CFG.sdi12CodecPath, 'SDI12');` then `getOrCreateProfileWithCodec(client, tenantId, CFG.profileSdi12Name, 'Dragino SDI-12-LB/LS soil probe converter (LoRaWAN 1.0.3 OTAA)', sdi12Script)`.
6. `envVars`: `CHIRPSTACK_PROFILE_SDI12: sdi12ProfileId`, plus the summary print line and the profile-count comment at the top (7 → 8).

- [ ] **Step 2: Wire the UCI-only recovery path in node-red.init**

Without this, a boot that recovers from UCI alone leaves
`CHIRPSTACK_PROFILE_SDI12` empty and the strict gate silently drops every
SDI-12 uplink. Next to the `cs_profile_kiwi` lines in
`feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`, add:

```sh
    local cs_profile_sdi12=$(resolve_chirpstack_value osi-server.cloud.chirpstack_profile_sdi12 CHIRPSTACK_PROFILE_SDI12)
```

and in the export block (~L230), next to `CHIRPSTACK_PROFILE_KIWI=…`:

```sh
        CHIRPSTACK_PROFILE_SDI12="$cs_profile_sdi12" \
```

- [ ] **Step 3: Sync the copies and verify**

```bash
cp scripts/chirpstack-bootstrap.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js
diff scripts/chirpstack-bootstrap.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js && echo IDENTICAL
node --check scripts/chirpstack-bootstrap.js
node scripts/verify-profile-parity.js   # bcm2709 mirror of the conf copy if parity includes it
git add -A && git commit -m "feat(sdi12): chirpstack profile + codec provisioning"
```

(If parity covers the conf copy, mirror it to bcm2709 first.)

---

### Task 9: Ingest flow tab

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (+ `cp` to bcm2709)

Invoke `osi-flows-json-editing` first. Model the UC512 tab (`c571729fb2943059` → `6b28e0d879808dd9` → debug) plus a config read, and the LSN50 tab's catch/link-out pattern.

**Interfaces:**
- Consumes: `osiLib.require('sdi12-normalize')` (Task 2), `osiLib.require('device-writer')`, `/srv/node-red/edge-channels.json` (Task 3), `CHIRPSTACK_PROFILE_SDI12` (Task 8).
- Produces: new tab `Sensor_SDI12` with nodes wired: `sdi12-mqtt-in` → `sdi12-gate-fn` → `sdi12-config-query-fn` → `sdi12-config-sqlite` → `sdi12-write-fn` → `sdi12-debug`; `sdi12-gate-fn` created with 2 outputs, output 2 left UNCONNECTED here (Task 10 wires it to `sdi12-identify-fn`); `record-error-catch-sdi12` → link-out to the shared error recorder.

- [ ] **Step 1: Create the tab and MQTT-in**

New `mqtt in` node `sdi12-mqtt-in` ("SDI12 IN"), broker `b0b19352dac3fb34`, topic exactly `application/+/device/+/event/up` (`scripts/check-mqtt-topics.sh` gates the literal string).

- [ ] **Step 2: Gate + decode function node (`sdi12-gate-fn`, 2 outputs)**

Create the node with 2 outputs. Output 2 (FPort 100 identify echoes) stays
**unconnected in this task** — Task 10 creates the identify handler and wires
it; an unconnected output is valid Node-RED, a wire to a nonexistent node is
not.

```js
// Output 1: FPort 2 periodic sensor payload -> config query chain.
// Output 2: FPort 100 identify echo -> identify handler (wired in Task 10).
// Everything else (FPort 5 status, FPort 3 datalog, unknown ports) is
// dropped with a visible status, never written.
var data = msg.payload;
if (!data || !data.deviceInfo) return null;
var profileId = String(data.deviceInfo.deviceProfileId || '').trim();
var sdi12ProfileId = String(env.get('CHIRPSTACK_PROFILE_SDI12') || '').trim();
if (!sdi12ProfileId || profileId !== sdi12ProfileId) return null; // strict id match, no name fallback
var deveui = String(data.deviceInfo.devEui || '').toUpperCase();
var fPort = Number(data.fPort);
var decoded = data.object || {};
msg.sdi12 = { deveui: deveui, fPort: fPort, decoded: decoded, recordedAt: data.time || null };
if (fPort === 100) return [null, msg];
if (fPort === 2 && decoded.unsupported_fport === undefined) return [msg, null];
node.status({ fill: 'grey', shape: 'ring', text: 'dropped fport ' + fPort + ' ' + deveui });
return null;
```

- [ ] **Step 3: Config query + sqlite read**

`sdi12-config-query-fn` (model: `lsn50-config-query-fn` — read it first for the exact escaping convention used with the sqlite node):

```js
msg.topic = 'SELECT sdi12_probe_profile, sdi12_probe_status, soil_moisture_probe_depths_json ' +
            'FROM devices WHERE deveui = $deveui';
msg.payload = { $deveui: String(msg.sdi12.deveui || '').toUpperCase() };
return msg;
```

`sdi12-config-sqlite`: sqlite node, db `734737e846d06893`, in **prepared**
mode (`sqlquery: "prepared"`) so `$deveui` binds from `msg.payload` — the
bound-parameters rule applies to new code even where the lsn50 chain
string-builds. Stash `msg.sdi12` survives the sqlite node (it replaces only
`msg.payload`).

- [ ] **Step 4: Normalize + Write function node (`sdi12-write-fn`)**

Setup tab `libs`: both `osiDb` (module `osi-db-helper`) and `osiLib` (module
`osi-lib`) — copy the libs config from the UC512 node `6b28e0d879808dd9`
verbatim. `fs` comes from `global.get('fs')`, not from libs. This body is
complete and adapted from the UC512 node's actual text (staged failure codes,
async open/write/close with a failure flag):

```js
var info = msg.sdi12;
if (!info) return null;
var row = Array.isArray(msg.payload) && msg.payload.length ? msg.payload[0] : {};

function reportFailure(stage) {
  var codes = {
    normalizer_load: 'NORMALIZER_LOAD_FAILED',
    writer_load: 'WRITER_LOAD_FAILED',
    manifest_load: 'MANIFEST_LOAD_FAILED',
    normalize_run: 'NORMALIZE_RUN_FAILED',
    db_open: 'DB_OPEN_FAILED',
    writer_run: 'WRITER_RUN_FAILED',
    db_close: 'DB_CLOSE_FAILED'
  };
  if (!Object.prototype.hasOwnProperty.call(codes, stage)) {
    throw new Error('sdi12 write: unknown failure stage ' + stage);
  }
  node.error('SDI12 write failed [' + stage + '] code=' + codes[stage], msg);
  node.status({ fill: 'red', shape: 'dot', text: 'SDI12 ' + codes[stage] });
  return null;
}

return (async () => {
  var normRes = osiLib.require('sdi12-normalize');
  if (!normRes.ok) return reportFailure('normalizer_load');

  var writerRes = osiLib.require('device-writer');
  if (!writerRes.ok) return reportFailure('writer_load');

  var fs = global.get('fs');
  var edgeManifest;
  try {
    edgeManifest = JSON.parse(fs.readFileSync('/srv/node-red/edge-channels.json', 'utf8'));
  } catch (e) {
    return reportFailure('manifest_load');
  }

  var result;
  try {
    result = normRes.value.normalize(
      info.decoded,
      { probeProfile: row.sdi12_probe_profile || null },
      { recordedAt: info.recordedAt }
    );
  } catch (e) {
    return reportFailure('normalize_run');
  }
  if (result.noResponse) {
    node.warn('sdi12 ' + info.deveui + ': probe returned NULL (no response)');
  }

  var db;
  try {
    db = new osiDb.Database('/data/db/farming.db');
  } catch (e) {
    return reportFailure('db_open');
  }

  var writerFailed = false;
  try {
    var writeResult = await writerRes.value.writeDeviceData(
      db, edgeManifest, result, { deveui: info.deveui }, { node: node, msg: msg });
    if (writeResult.deadLettered.length > 0) {
      // Dead-letters must be visible in the editor, not silently green.
      node.warn('sdi12 dead-lettered ' + writeResult.deadLettered.length + ' channels for ' + info.deveui);
      node.status({ fill: 'yellow', shape: 'dot',
        text: info.deveui + ' cols=' + writeResult.columns.length + ' dead=' + writeResult.deadLettered.length });
    } else {
      node.status({ fill: 'green', shape: 'dot', text: info.deveui + ' cols=' + writeResult.columns.length });
    }
    msg.payload = writeResult;
  } catch (e) {
    writerFailed = true;
    reportFailure('writer_run');
  }

  try {
    await db.close();
  } catch (closeErr) {
    reportFailure('db_close');
  }

  return writerFailed ? null : msg;
})();
```

- [ ] **Step 5: Telemetry dispatcher mapping**

In node `8809bb5239dfb3d4` ("Build Telemetry"), two changes — the type
mapping alone publishes none of the new values:

1. Extend `getProfileKind()` with an explicit branch mapping
   `CHIRPSTACK_PROFILE_SDI12` → `'DRAGINO_SDI12'` (without it the fallback
   labels the device `KIWI_SENSOR`), following the existing UC512/LSN50
   branch shape.
2. The node enumerates the telemetry fields it publishes: add the 24
   `vwc_*`/`soil_temp_*`/`soil_ec_*` fields wherever `swt_1`-style fields
   are copied into the telemetry payload, following that node's existing
   field-copy shape.

- [ ] **Step 6: Catch node, mirror, gates, commit**

Add `record-error-catch-sdi12` (catch, scoped to the new tab) → link-out to the shared error recorder (copy the LSN50 tab's `record-error-link-out-lsn50` wiring). Then:

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
bash scripts/check-mqtt-topics.sh
node scripts/flows-bare-require-scan.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js    # update its baseline per the script's instructions if it flags growth
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
git add -A && git commit -m "feat(sdi12): ingest tab - strict profile gate, config read, narrow-waist write"
```

---

### Task 10: Auto-identification (FPort 100 handler + identify endpoint)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (+ mirror)

Invoke `osi-flows-json-editing`. Downlinks are published to the ChirpStack MQTT topic `application/<applicationId>/device/<devEui>/command/down` with payload `{devEui, confirmed:false, fPort, data:<base64>}` — copy the mqtt-out wiring from the LSN50 mode-downlink chain (`lsn50-mode-downlink-fn` on tab `8a18de184886c8a8`).

**Interfaces:**
- Consumes: `sdi12-gate-fn` output 2 (created unwired in Task 9); `matchProfile`/`parseIdentity` (Task 2).
- Produces: `POST /api/devices/:deveui/sdi12/identify`; a shared identify-trigger link (`sdi12-identify-trigger-link-in`) that Task 11 invokes post-registration; devices row transitions `pending_identify → identified | unmatched`.

All SQL in this task runs through `osiDb` with bound `?` parameters
(playbook: "bound parameters only" — the older lsn50 string-SQL chains are
legacy, not license). Function nodes here declare `libs: osiDb + osiLib`
like the Task 9 write node.

- [ ] **Step 1: Wire gate output 2 and add the identify handler (`sdi12-identify-fn`)**

Connect `sdi12-gate-fn` output 2 → `sdi12-identify-fn`:

```js
var info = msg.sdi12;
if (!info) return null;
var normRes = osiLib.require('sdi12-normalize');
if (!normRes.ok) { node.error('osi-lib load failed: ' + normRes.error, msg); return null; }
var identity = String((info.decoded && info.decoded.datas_sum) || '').trim();
var hit = normRes.value.matchProfile(identity);   // null for every v1 profile until bench enables matchers

return (async () => {
  var db = new osiDb.Database('/data/db/farming.db');
  try {
    if (hit) {
      // Guarded: a manual choice (status 'manual') must never be overwritten by a late echo.
      await db.run(
        "UPDATE devices SET sdi12_probe_profile = ?, sdi12_probe_status = 'identified', " +
        "sdi12_identity = ?, sync_version = COALESCE(sync_version,0) + 1, " +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
        "WHERE deveui = ? AND sdi12_probe_status = 'pending_identify'",
        [hit.profileId, identity, info.deveui]);
      node.status({ fill: 'green', shape: 'dot', text: info.deveui + ' -> ' + hit.profileId });
    } else {
      // Terminal no-match state, same guard: identity is stored for the GUI
      // to display next to the manual profile picker.
      await db.run(
        "UPDATE devices SET sdi12_probe_status = 'unmatched', sdi12_identity = ?, " +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
        "WHERE deveui = ? AND sdi12_probe_status = 'pending_identify'",
        [identity, info.deveui]);
      node.warn('sdi12 identify: no profile match for "' + identity + '" (' + info.deveui + ')');
      node.status({ fill: 'yellow', shape: 'dot', text: info.deveui + ' unmatched' });
    }
  } finally {
    await db.close();
  }
  return msg;
})();
```

- [ ] **Step 2: Shared identify trigger + endpoint**

One trigger function node (`sdi12-identify-trigger-fn`) behind a link-in
(`sdi12-identify-trigger-link-in`), so registration (Task 11) and the
endpoint both invoke identical logic. Input contract: `msg.deviceRow` with
`deveui` and `chirpstack_app_id`. The node validates before touching state
and surfaces enqueue problems instead of leaving a silent pending:

```js
// Dragino 0xA8: execute ad-hoc SDI-12 command.
// Frame: A8 | len | cmd bytes | delay(s) | echo(0/1) | aD0(0/1).
// "0I!" = 0x30 0x49 0x21. Echo=1 so the reply arrives on FPort 100.
// NOTE: frame layout + downlink FPort are manual-derived; bench confirmation
// of this frame is a pre-merge gate (see Bench phase item 5).
var row = msg.deviceRow || {};
var deveui = String(row.deveui || '').toUpperCase();
var appId = String(row.chirpstack_app_id || '').trim();
if (!/^[0-9A-F]{16}$/.test(deveui) || !appId) {
  msg.statusCode = 409;
  msg.payload = { message: 'device is missing ChirpStack registration data; cannot identify' };
  return [null, msg];   // output 2: error response path
}
var rawBytes = [0xA8, 0x03, 0x30, 0x49, 0x21, 0x01, 0x01, 0x00];

return (async () => {
  var db = new osiDb.Database('/data/db/farming.db');
  try {
    await db.run(
      "UPDATE devices SET sdi12_probe_status = 'pending_identify', " +
      "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE deveui = ?",
      [deveui]);
  } finally {
    await db.close();
  }
  msg.downlink = {
    topic: 'application/' + appId + '/device/' + deveui.toLowerCase() + '/command/down',
    payload: {
      devEui: deveui.toLowerCase(),
      confirmed: false,
      fPort: 2,
      data: Buffer.from(rawBytes).toString('base64')
    }
  };
  return [msg, null];   // output 1: -> mqtt-out + 202 response
})();
```

`POST /api/devices/:deveui/sdi12/identify` is cloned from the
`PUT …/lsn50/mode` chain's node sequence (`*-auth-fn` → `*-lookup` sqlite →
`*-authorize-fn` → action → `*-format`); reuse its auth/ownership code
verbatim, then link out to the shared trigger and format a 202 with
`{ status: 'pending_identify' }` (or the trigger's error response).

- [ ] **Step 3: Command-safety registry**

Register the new downlink action in `cmd-type-registry` ("Command Type Registry", tab `sys-admin-tab`) following the LSN50 interval command's entry shape, then run `node scripts/verify-command-safety.js` — expect PASS.

- [ ] **Step 4: Mirror, gates, commit**

Same gate block as Task 9 Step 6.

```bash
git add -A && git commit -m "feat(sdi12): aI! auto-identification via 0xA8 downlink + FPort 100 handler"
```

---

### Task 11: Registration surfaces

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (+ mirror): nodes `catalog-response`, `post-devices-auth`, `post-devices-insert`

Invoke `osi-flows-json-editing`.

- [ ] **Step 1: Catalog entry**

In `catalog-response` ("Return Catalog"), add:

```js
{ id: 'DRAGINO_SDI12', name: 'Dragino SDI-12 Soil Node (LB/LS)' },
```

- [ ] **Step 2: Auth allow-list (+ pre-existing bug fix)**

In `post-devices-auth`, the type allow-list is missing two shipped types. Replace it with the complete list:

```js
if (!['KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120',
      'AQUASCOPE_LORAIN','MILESIGHT_UC512','DRAGINO_SDI12'].includes(type_id)) {
```

- [ ] **Step 3: Insert maps**

In `post-devices-insert`, add to both maps:

```js
DRAGINO_SDI12: env.get('CHIRPSTACK_APP_SENSORS'),      // appMap
DRAGINO_SDI12: env.get('CHIRPSTACK_PROFILE_SDI12'),    // profileMap
```

(No `joinEuiMap` entry — Dragino uses per-device AppEUIs entered at registration.)

- [ ] **Step 4: Post-registration identify hook**

The spec's "registration starts identification" is a wiring obligation, not
prose. Add `sdi12-post-reg-hook-fn` on the success path after
`cs-register-device-fn` (parallel to "Format Response", so the HTTP response
is unaffected):

```js
// Auto-start probe identification for freshly registered SDI-12 nodes.
if (!msg.deviceRegistration || msg.deviceRegistration.deviceType !== 'DRAGINO_SDI12') return null;
msg.deviceRow = {
  deveui: String(msg.deviceRegistration.devEui || '').toUpperCase(),
  chirpstack_app_id: msg.deviceRegistration.applicationId
};
return msg;   // -> link-out to sdi12-identify-trigger-link-in (Task 10)
```

A failed identify enqueue must not fail the registration — the hook rides a
separate branch and its errors land in the tab's catch node.

- [ ] **Step 5: Mirror, gates, commit**

Same gate block as Task 9 Step 6.

```bash
git add -A && git commit -m "feat(sdi12): registration - catalog, auth allow-list (incl. lorain/uc512 fix), chirpstack maps"
```

---

### Task 12: Config API endpoints

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (+ mirror)

Invoke `osi-flows-json-editing`. Clone the `put-chameleon-enabled-*` chain (device-config auth precedent) for the PUT; read it first and reuse its auth verbatim.

**Interfaces:**
- Produces: `GET /api/sdi12/probe-profiles` returning `listProfiles()` output; `PUT /api/devices/:deveui/sdi12/config` accepting `{ probe_profile: string, depths: Record<depthSlot, cm> }` (slot-keyed; the endpoint fans depths out to the slot's channels and stores channel-keyed).

- [ ] **Step 1: GET /api/sdi12/probe-profiles**

http-in (GET) → function → http response:

```js
var normRes = osiLib.require('sdi12-normalize');
if (!normRes.ok) {
  msg.statusCode = 503;
  msg.payload = { message: 'profile registry unavailable' };
  return msg;
}
msg.payload = { profiles: normRes.value.listProfiles() };
return msg;
```

- [ ] **Step 2: PUT /api/devices/:deveui/sdi12/config**

After the cloned auth/ownership nodes, the action node validates and updates:

Libs: `osiDb` + `osiLib`, as in Task 9. Depths are validated against the
**selected profile's exact channel set** (per depth slot, fanned out to that
slot's channels) and the stored map is replaced, never merged — stale keys
from a previous profile must not survive a profile change:

```js
var body = msg.req.body || {};
var normRes = osiLib.require('sdi12-normalize');
if (!normRes.ok) { msg.statusCode = 503; msg.payload = { message: 'profile registry unavailable' }; return msg; }
var profileId = String(body.probe_profile || '').trim();
var profile = normRes.value.getProfile(profileId);
if (!profile) {
  msg.statusCode = 400; msg.payload = { message: 'Unknown probe_profile' }; return msg;
}
// depths: { "<slot>": cm } keyed by the profile's physical depth slots.
var slotDepths = body.depths;
var depthsByChannel = null;
if (slotDepths !== undefined) {
  if (typeof slotDepths !== 'object' || slotDepths === null || Array.isArray(slotDepths)) {
    msg.statusCode = 400; msg.payload = { message: 'depths must be an object of depthSlot->cm' }; return msg;
  }
  var validSlots = {};
  profile.values.forEach(function (v) { if (v.depthSlot) validSlots[v.depthSlot] = true; });
  depthsByChannel = {};
  for (var slot in slotDepths) {
    var cm = slotDepths[slot];
    if (!validSlots[Number(slot)] || !Number.isFinite(cm) || cm < 0 || cm > 500) {
      msg.statusCode = 400; msg.payload = { message: 'invalid depth entry for slot ' + slot }; return msg;
    }
    profile.values.forEach(function (v) {
      if (v.depthSlot === Number(slot)) depthsByChannel[v.channel] = cm;   // fan out per channel
    });
  }
}
var deveui = String(msg.deviceRow.deveui || '').toUpperCase();

return (async () => {
  var db = new osiDb.Database('/data/db/farming.db');
  try {
    if (depthsByChannel !== null) {
      await db.run(
        "UPDATE devices SET sdi12_probe_profile = ?, sdi12_probe_status = 'manual', " +
        "soil_moisture_probe_depths_json = ?, soil_moisture_probe_depths_configured = 1, " +
        "sync_version = COALESCE(sync_version,0) + 1, " +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE deveui = ?",
        [profileId, JSON.stringify(depthsByChannel), deveui]);
    } else {
      await db.run(
        "UPDATE devices SET sdi12_probe_profile = ?, sdi12_probe_status = 'manual', " +
        "sync_version = COALESCE(sync_version,0) + 1, " +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE deveui = ?",
        [profileId, deveui]);
    }
  } finally {
    await db.close();
  }
  msg.payload = { probe_profile: profileId, status: 'manual', depths: depthsByChannel };
  return msg;
})();
```

- [ ] **Step 3: Mirror, gates, commit**

Same gate block as Task 9 Step 6.

```bash
git add -A && git commit -m "feat(sdi12): probe-profile listing + device config endpoints"
```

---

### Task 13: GUI — types, data plumbing, card

**Files:**
- Modify: `web/react-gui/src/types/farming.ts` (line 2 union; Device interface; `latest_data` shape ~L18)
- Modify: `web/react-gui/src/services/api.ts` (device mapping — check the depths parsing at ~L176 passes the new fields through)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm{2712,2709}/files/usr/share/flows.json` — "Format Response" (~flows:525) + "Merge Data" (~flows:561) latest-data chain, and the sensor export "Build SQL + Params" (~flows:3287). Invoke `osi-flows-json-editing`; mirror + run the Task 9 gate block after.
- Create: `web/react-gui/src/components/farming/Sdi12SoilCard.tsx`
- Create: `web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx`

**Interfaces:**
- Consumes: device rows with `sdi12_probe_profile`, `sdi12_probe_status`, `soil_moisture_probe_depths_json`; latest `device_data` values under the 24 channel keys + `swt_1..3` + `bat_v`.
- Produces: `<Sdi12SoilCard device={device} onOpenSettings={...} />` used by Task 14; `/api/devices` responses and the sensor CSV export actually carrying the 24 new fields.

- [ ] **Step 1: Data plumbing — the values must reach the card and the export**

Declaring manifest entries exposes nothing by itself; three enumerating
surfaces need the 24 columns added explicitly:

1. The `/api/devices` latest-data chain: "Format Response" builds the
   latest-data query and "Merge Data" reconstructs each device's
   `latest_data` — read both nodes, find where `swt_1`/`adc_ch0v`-style
   fields are selected and copied, and add `vwc_1..8`, `soil_temp_1..8`,
   `soil_ec_1..8` the same way.
2. The sensor export node "Build SQL + Params": add the 24 columns to its
   explicit select list so CSV export carries them.
3. `types/farming.ts` `latest_data`: add the 24 optional members
   (`vwc_1?: number | null;` … `soil_ec_8?: number | null;`) next to the
   existing channel fields.

- [ ] **Step 2: Types**

```ts
export type DeviceType = 'KIWI_SENSOR' | 'STREGA_VALVE' | 'DRAGINO_LSN50' | 'TEKTELIC_CLOVER'
  | 'SENSECAP_S2120' | 'AQUASCOPE_LORAIN' | 'MILESIGHT_UC512' | 'DRAGINO_SDI12';

export type Sdi12ProbeStatus = 'pending_identify' | 'identified' | 'unmatched' | 'manual';
// On the Device interface, next to soil_moisture_probe_depths_json:
  sdi12_probe_profile?: string | null;
  sdi12_probe_status?: Sdi12ProbeStatus | null;
  sdi12_identity?: string | null;   // shown next to the manual picker when status is 'unmatched'
```

- [ ] **Step 3: Failing card test**

Before writing the card, read `KiwiSensorCard.tsx` fully — it is the template for depth-label lookup (`soil_moisture_probe_depths_json?.[channelKey]`, ~L44) and for how latest values reach the card. Read one existing card test in `components/farming/__tests__/` and mirror its render/mock setup. The test asserts:

```tsx
// Renders one row per populated depth with value + unit + depth label;
// renders the probe-status chip; hides EC column when no soil_ec_* present.
it('renders populated vwc depths with labels and status chip', () => {
  render(<Sdi12SoilCard device={makeDevice({
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
    sdi12_probe_status: 'identified',
    soil_moisture_probe_depths_json: { vwc_1: 10, vwc_2: 20 },
    latest: { vwc_1: 30.5, vwc_2: 28.1, bat_v: 3.3 },
  })} />);
  expect(screen.getByText(/30\.5/)).toBeInTheDocument();
  expect(screen.getByText(/10\s*cm/)).toBeInTheDocument();
  expect(screen.getByText(/identified/i)).toBeInTheDocument();
  expect(screen.queryByText(/µS\/cm/)).not.toBeInTheDocument();
});
it('shows pending state when unidentified', () => {
  render(<Sdi12SoilCard device={makeDevice({ sdi12_probe_status: 'pending_identify', latest: { bat_v: 3.3 } })} />);
  expect(screen.getByText(/detecting probe|pending/i)).toBeInTheDocument();
});
```

Run: `cd web/react-gui && npx vitest run src/components/farming/__tests__/Sdi12SoilCard.test.tsx` — expect FAIL (module missing).

- [ ] **Step 4: Implement the card**

Structure (align imports/props with `KiwiSensorCard.tsx` — literal strings, no `useTranslation`, matching the existing device cards):

- Header: device name + probe-profile label (or "No probe profile") + status chip.
- Body: for depths 1..8, a row is rendered when any of `vwc_N` / `soil_temp_N` / `soil_ec_N` / `swt_N` has a value; each row shows the depth label from `soil_moisture_probe_depths_json` (fall back to `#N`), then the populated values with units (`%`, `°C`, `µS/cm`, `kPa`).
- For `swt_N` values additionally show pF via the existing `kpaToPf` from `web/react-gui/src/utils/swt.ts`, formatted with its `formatSwtValue` conventions.
- Footer: `DeviceCardFooter` exactly as `DraginoTempCard.tsx` passes it (`batteryPercent`/`batteryVoltage`).
- Settings gear opens `Sdi12SettingsModal` (Task 14) — render the button in this task, accept an `onOpenSettings` prop so this task tests independently.

- [ ] **Step 5: Run tests + flows gates, commit**

```bash
cd web/react-gui && npx vitest run src/components/farming/__tests__/Sdi12SoilCard.test.tsx && cd ../..
grep -c "vwc_8" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json   # expect >= 2 (latest-data chain + export)
node scripts/test-flows-wiring.js && node scripts/verify-flows-fn-parse.js
node scripts/verify-profile-parity.js
git add -A && git commit -m "feat(sdi12): device type, latest-data/export plumbing, soil card"
```

---

### Task 14: GUI — settings modal, dashboard wiring, history eligibility

**Files:**
- Create: `web/react-gui/src/components/farming/Sdi12SettingsModal.tsx` + `__tests__/Sdi12SettingsModal.test.tsx`
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx` (~L103-106 filters, ~L261 render block)
- Modify: `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` (~L129-133 filters, render blocks ~L427+)
- Modify: `web/react-gui/src/channels/registry.ts` (device-type branch at ~L65)
- Modify: `web/react-gui/src/services/api.ts` (three fetch helpers)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm{2712,2709}/files/usr/share/node-red/osi-history-router/index.js` (~L245-259 card eligibility) and `osi-history-helper/index.js` (~L301-310)

**Interfaces:**
- Consumes: Task 12 endpoints; Task 13 card.
- Produces: API helpers `fetchSdi12Profiles(): Promise<{profiles: Sdi12Profile[]}>`, `putSdi12Config(deveui, body): Promise<void>`, `postSdi12Identify(deveui): Promise<void>` in `services/api.ts` (follow the file's existing fetch-helper idiom).

- [ ] **Step 1: Failing modal test**

```tsx
it('lists profiles from the API and saves profile + depths', async () => {
  // mock fetchSdi12Profiles -> [{id:'TENSIOMARK', label:'ecoTech Tensiomark', provisional:true,
  //   defaultDepthsCm:[30], channels:['swt_1','soil_temp_1']}]
  // select TENSIOMARK, set depth 30 for slot 1, save
  // assert putSdi12Config called with { probe_profile: 'TENSIOMARK', depths: { "1": 30 } }  // slot-keyed
});
it('detect button posts identify', async () => {
  // click "Detect probe", assert postSdi12Identify(deveui) called and pending hint shown
});
```

Write these as real tests using the mocking style of the existing modal tests in the same directory (read `DraginoSettingsModal` usage/tests first). Run to verify FAIL.

- [ ] **Step 2: Implement modal + api helpers**

Modal contents: profile `<select>` (label + "(unverified)" suffix when `provisional`), a depths editor rendering **one numeric input per `depthSlot`** of the selected profile (pre-filled from `defaultDepthsCm` by slot position, overridden by existing stored depths; the endpoint fans each slot's value out to its channels), the stored `sdi12_identity` displayed when status is `unmatched` to assist the manual pick, a "Detect probe" button calling `postSdi12Identify` (showing pending age from `updated_at` while status is `pending_identify`), save calling `putSdi12Config`. Follow `DraginoSettingsModal.tsx` for modal chrome and error-text conventions (mind the `--error-text` readability rule from the journal work).

- [ ] **Step 3: Dashboard + zone card wiring**

- `FarmingDashboard.tsx`: add `unassignedSdi12 = devices.filter(d => d.type_id === 'DRAGINO_SDI12' && !d.irrigation_zone_id)` beside the existing filters, and a render block titled `SDI-12 Soil Nodes` rendering `<Sdi12SoilCard>` per device, matching the LSN50 block at ~L261.
- `IrrigationZoneCard.tsx`: add `sdi12Nodes` to the ~L129-133 filter group and a `<Sdi12SoilCard>` render section beside the existing per-type sections.
- `channels/registry.ts`: in `cardChannelsForSource`, add a `DRAGINO_SDI12` branch returning the union of the device's populated soil channels (mirror how the `DRAGINO_LSN50` branch at ~L65 selects by flags — here select all `vwc_*`/`soil_temp_*`/`soil_ec_*`/`swt_*` soil channels).

- [ ] **Step 4: History card eligibility (edge helpers)**

In `osi-history-router/index.js` (~L245-259) and `osi-history-helper/index.js` (~L301-310): extend the soil-card eligibility so `type_id === 'DRAGINO_SDI12'` qualifies, alongside the existing KIWI/CLOVER/chameleon condition. Mirror both files to bcm2709.

- [ ] **Step 5: Tests, gates, commit**

```bash
cd web/react-gui && npx vitest run src/components/farming/__tests__/ src/channels/__tests__/ && npx tsc --noEmit -p . && cd ../..
node scripts/verify-channel-manifest-parity.js
node scripts/verify-profile-parity.js
git add -A && git commit -m "feat(sdi12): settings modal, dashboard/zone wiring, history soil-card eligibility"
```

Also run any pre-existing history tests that touch card eligibility: `npx vitest run src/components/history/__tests__/ src/history/__tests__/`.

---

### Task 15: Device-integration golden vectors

**Files:**
- Create: `scripts/fixtures/device-integration/sdi12/golden-vectors.json`
- Modify: `scripts/verify-device-integration.js` (add the sdi12 device block)
- Modify: `.github/workflows/codecs.yml` (add `- run: node scripts/verify-device-integration.js` — it currently runs nowhere)

**Interfaces:**
- Consumes: codec (Task 1), normalize (Task 2), schema slice (Task 4), manifest (Task 3).

- [ ] **Step 1: Read the UC512 fixture and runner**

Read `scripts/fixtures/device-integration/uc512/golden-vectors.json` and the uc512 block in `scripts/verify-device-integration.js`; mirror their exact structure for sdi12 (the runner drives codec → normalizer → `osi-device-writer` → in-memory DB seeded from seed-blank.sql). The sdi12 block must additionally pass `deviceConfig` (`{probeProfile}`) into `normalize` — extend the runner's normalize call for this device the same way the flow node does.

- [ ] **Step 2: Vectors (frame bytes → expected row)**

At minimum these four (battery bytes `0x0C 0xE4` = 3.300 V, payver `0x01`; ASCII shown as text — encode to bytes in the fixture format the runner expects):

| # | probeProfile | FPort 2 ASCII | expected device_data |
|---|---|---|---|
| 1 | `TENSIOMARK` | `+2.48+21.5` | `swt_1 = 30.2`, `soil_temp_1 = 21.5`, `bat_v = 3.3` |
| 2 | `GENERIC_VWC` | `+30.5+28.1+25.9` | `vwc_1 = 30.5`, `vwc_2 = 28.1`, `vwc_3 = 25.9`, `bat_v = 3.3` |
| 3 | `GENERIC_VWC` | `NULL` | `bat_v = 3.3` only, no quarantine rows |
| 4 | `GENERIC_VWC` | `0+30.5` | `bat_v = 3.3` only, one `ingest_quarantine` row with reason `unknown_channel` and channel `unparseable_sdi12` |
| 5 | `TENSIOMARK` | `+2.48+21.5+9.9` | `bat_v = 3.3` only (cardinality mismatch rejects atomically), one quarantine row with channel `sdi12_value_count` |

- [ ] **Step 3: Run + commit**

```bash
node scripts/verify-device-integration.js
git add -A && git commit -m "feat(sdi12): golden-vector round-trip + wire device-integration into CI"
```

---

### Task 16: Scheduler zone-mean verification

**Files:**
- Read (and only modify if needed): `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` node `5f0d2b7e9b9b1b3a` ("Decide + build actuator cmd + build DB logs") and the latest-data query feeding it

- [ ] **Step 1: Verify the SWT source query is type-agnostic**

Inspect the SQL that computes the zone SWT mean (`COALESCE(dd.swt_1, dd.swt_wm1)` pattern). Determine whether it selects devices by zone membership alone or filters `type_id`.

- [ ] **Step 2: Act on the finding**

- Type-agnostic → no change; record the evidence (the query text) in the execution report.
- Type-filtered → add `DRAGINO_SDI12` to the filter (flows edit via `osi-flows-json-editing`, mirror to bcm2709, run the Task 9 gate block), and commit:

```bash
git add -A && git commit -m "fix(sdi12): include DRAGINO_SDI12 in scheduler swt source"
```

---

### Task 17: Documentation

**Files:**
- Create: `docs/devices/dragino-sdi12.md`
- Modify: `AGENTS.md` (device catalog section — add the `DRAGINO_SDI12` row following the existing rows' format)

- [ ] **Step 1: Write the device doc**

Contents (all bench-status items explicitly labeled "unverified until bench capture"):

1. What the node is, LB vs LS, one probe at SDI-12 address 0.
2. Commissioning: register in GUI → auto-identify flow → manual fallback; bench AT setup over USB console.
3. Per-probe AT recipe sections (EnviroSCAN, PR2/4, PR2/6, Tensiomark, PICO64, HydraScout): the `AT+COMMANDx`/`AT+DATACUTx` lines, with the hard rule that DATACUT must strip address characters and CRC so the uplink matches `^([+-][0-9.]+)+$`; TDC recommendation (20 min default).
4. The `0xA8`/`0xAF`/`0x01` downlinks used or reserved.
5. Troubleshooting: `NULL` uplinks; the quarantine tuple as it actually lands
   (reason is always `unknown_channel` for normalizer rejects — the marker is
   the **channel** column: `unparseable_sdi12`, `sdi12_value_count`,
   `sdi12_unconfigured`, `<channel>:out_of_range`); the 1,000-row quarantine
   cap; yellow node status meaning dead-letters; FPort 100 debugging;
   `unmatched` identify status and what to do about it.

Run `node .claude/skills/anti-slop-writing/slop-check.js docs/devices/dragino-sdi12.md` — expect PASS.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "docs(sdi12): device guide + AGENTS.md catalog row"
```

---

### Task 18: Full gate battery

- [ ] **Step 1: Run everything**

```bash
node scripts/verify-sdi12-codec.js
node scripts/verify-codec-robustness.js
node scripts/verify-lsn50-chameleon-codec.js   # regression: shared dir, untouched behavior
node scripts/verify-device-integration.js
node scripts/verify-helper-registration.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-channel-manifest-parity.js
node scripts/verify-sync-contract.js
node scripts/verify-command-safety.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-no-new-silent-catch.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-size-ratchet.js
node scripts/test-flows-wiring.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-boot-ddl-interpolation.js
bash scripts/check-mqtt-topics.sh
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
(cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize && node --test)
(cd web/react-gui && npx vitest run && npx tsc --noEmit -p .)
# Production build LAST and ALONE - this workstation OOMs on concurrent
# frontend builds (zram swap, no disk fallback). Never parallelize it.
(cd web/react-gui && npm run build)
```

Expected: every command PASS. Any failure: fix, re-run the full block (not just the failed command), and only then proceed.

- [ ] **Step 2: Final commit if fixes were needed**

```bash
git add -A && git commit -m "chore(sdi12): gate battery fixes"
```

---

## Bench phase (hardware; not subagent tasks)

These require the physical SDI-12-LB/LS and the probes; they finalize what the code ships as `provisional: true`. For each probe (EnviroSCAN, PR2/4 or /6, Tensiomark, PICO64, HydraScout):

1. Wire the probe, apply the draft AT recipe from `docs/devices/dragino-sdi12.md` over USB.
2. Capture: the `aI!` identity via the identify endpoint (or `0xA8` manually), and several FPort 2 uplinks (raw hex + decoded `data_sum`).
3. Correct the profile in `osi-sdi12-normalize` (value order, transforms,
   `expectedValues`, `depthSlot`s), flip `provisional: false`, update
   `defaultDepthsCm`, and re-check the payload budget test.
4. Enable `identityMatch` ONLY if the captured vendor+model uniquely
   determines the value layout (PR2/4 vs PR2/6 share an identity: those stay
   manual permanently); add a `matchProfile` test from the real capture.
5. Add one golden vector per probe from a real capture to `scripts/fixtures/device-integration/sdi12/golden-vectors.json`.
6. Confirm the `0xA8` frame layout (Task 10's `rawBytes`) and the downlink
   FPort against the live device; correct if the manual reading was wrong.
   **This confirmation is a pre-merge gate for the identify feature** — the
   frame is manual-derived and unverified until a real device echoes on
   FPort 100.
7. Update the AT recipe section from what actually worked; drop the "unverified" labels.

Each probe's correction is its own small commit: `fix(sdi12): <probe> profile from bench capture`.

## Companion work (tracked, not in this plan)

- **osi-server lockstep — a MERGE GATE, not post-merge work:** this branch
  does not merge before the paired osi-server branch is ready to
  pair-deploy. Server scope: `type_id` enum (`DeviceType.java`), channel
  manifest copies (per `docs/channel-manifest.md` sync procedure),
  `sdi12_probe_profile` on the Device resource, telemetry/`DEVICE_DATA_APPENDED`
  consumption of the 24 fields, history mapper
  (`DeviceDataHistoryMapper.java`), and the paired half of any
  bulk-history-hash extension (`osi-history-sync-helper` hashes a fixed
  column list; extending one side alone breaks sync).
- Phase 2: remote AT-recipe push via `0xAF` downlinks (zero-touch
  commissioning); `AT+DATAUP=1` multi-segment reassembly to unlock >6-value
  probes (EnviroSCAN 8 depths, HydraScout full depth count).
- VWC as a scheduler trigger metric.
- Operator-facing quarantine surface (GUI or gateway-health field) beyond
  the yellow node status shipped here.
