# Reproducible Pi Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pi communication reproducible from the repo by removing hardcoded ChirpStack app IDs, making runtime config deterministic, adding validation gates, and creating safe diagnostics before live rollout.

**Architecture:** Keep `flows.json` installation-neutral and move all per-installation ChirpStack IDs into runtime configuration. UCI is canonical, `.chirpstack.env` is a per-key compatibility fallback, and bootstrap provisions/discovers resources without mutating flow behavior. Verification scripts and deploy preflight enforce these contracts before any artifact is copied to a Pi.

**Tech Stack:** Node-RED flow JSON, POSIX/OpenWrt shell init scripts, Node.js bootstrap and verification scripts, BusyBox-compatible diagnostics, SQLite read-only checks when `sqlite3` is available.

---

## File Structure

- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`: primary RPi 5 flow; remove STREGA `FIXED_APP_ID`, use `CHIRPSTACK_APP_ACTUATORS`, and fail visibly if missing.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`: RPi 3/4 full flow; same STREGA downlink runtime app behavior.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json`: older full flow; same STREGA downlink runtime app behavior.
- Create `scripts/verify-communication-contract.js`: focused communication contract verifier that can run in CI, from `verify-sync-flow.js`, and inside deploy preflight with a small fetched file set.
- Modify `scripts/verify-sync-flow.js`: enforce all platform flows, no `FIXED_APP_ID`, runtime app use, bootstrap source contract, and init fallback contract.
- Modify `scripts/chirpstack-bootstrap.js`: persist ChirpStack IDs to UCI, stop rewriting MQTT topics, stop patching STREGA code in normal bootstrap, and keep env-file writing as compatibility output.
- Modify `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`: load `.chirpstack.env` as a per-key fallback for ChirpStack IDs, while keeping UCI precedence.
- Modify `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`: add a checked-in `.chirpstack.env` loader so a checkout plus deploy behaves consistently when Node-RED is started outside procd or when compatibility env files exist.
- Modify `deploy.sh`: run communication validation before copying flow/init/settings artifacts.
- Create `scripts/diagnose-pi-communication.sh`: read-only Pi diagnostic for pre/post rollout evidence.
- Modify `scripts/check-mqtt-topics.sh` only if the platform flow list changes; keep it focused on MQTT IN topics and leave broad flow assertions in `scripts/verify-communication-contract.js`.

## Task 1: Flow Contract And STREGA Runtime App ID

**Files:**
- Create: `scripts/verify-communication-contract.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json`

- [ ] **Step 1: Create focused communication contract verifier**

Create `scripts/verify-communication-contract.js`:

```js
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = process.env.REPO_ROOT
  ? path.resolve(process.env.REPO_ROOT)
  : path.resolve(__dirname, '..');
const platformFlowPaths = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json'
];
const nodeRedInitPath = 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init';
const nodeRedSettingsPath = 'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js';
const chirpstackBootstrapPath = 'scripts/chirpstack-bootstrap.js';
const diagnosticPath = 'scripts/diagnose-pi-communication.sh';
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(relativePath, options = {}) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    if (options.optional) return '';
    fail(`missing required file: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function expectIncludes(label, source, needle, description) {
  if (!source.includes(needle)) {
    fail(`${label}: ${description}; missing ${needle}`);
  }
}

function expectExcludes(label, source, needle, description) {
  if (source.includes(needle)) {
    fail(`${label}: ${description}; found ${needle}`);
  }
}

function parseFlow(relativePath) {
  const source = read(relativePath);
  if (!source) return [];
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${relativePath}: invalid JSON: ${error.message}`);
    return [];
  }
}

for (const relativePath of platformFlowPaths) {
  const source = read(relativePath);
  const nodes = parseFlow(relativePath);
  expectExcludes(relativePath, source, 'FIXED_APP_ID', 'must not contain hardcoded STREGA app IDs');
  const badMqttTopics = nodes
    .filter((node) => node.type === 'mqtt in' && node.topic !== 'application/+/device/+/event/up')
    .map((node) => `${node.name || node.id}: ${node.topic || ''}`);
  if (badMqttTopics.length) {
    fail(`${relativePath}: MQTT IN topics must be wildcarded:\n${badMqttTopics.join('\n')}`);
  }
  const strega = nodes.find((node) => node.name === 'Build STREGA downlink + emit log ctx');
  const stregaSource = String(strega && strega.func || '');
  if (!stregaSource) fail(`${relativePath}: missing Build STREGA downlink + emit log ctx`);
  expectIncludes(relativePath, stregaSource, "env.get('CHIRPSTACK_APP_ACTUATORS')", 'STREGA downlink uses runtime Actuators app ID');
  expectIncludes(relativePath, stregaSource, 'Missing CHIRPSTACK_APP_ACTUATORS', 'STREGA downlink fails loudly when Actuators app ID is missing');
  expectExcludes(relativePath, stregaSource, 'application/${FIXED_APP_ID}', 'STREGA downlink must not publish to a hardcoded app topic');
  expectIncludes(relativePath, source, "env.get('CHIRPSTACK_PROFILE_CLOVER')", 'keeps Clover compatibility profile routing');
}

const nodeRedInit = read(nodeRedInitPath);
expectIncludes(nodeRedInitPath, nodeRedInit, 'load_chirpstack_env_value()', 'defines a per-key .chirpstack.env fallback reader');
expectIncludes(nodeRedInitPath, nodeRedInit, 'resolve_chirpstack_value()', 'resolves UCI first and env fallback second for ChirpStack IDs');
expectIncludes(nodeRedInitPath, nodeRedInit, 'CHIRPSTACK_APP_FIELD_TESTER="$cs_app_field_tester"', 'exports the field tester application ID');
expectIncludes(nodeRedInitPath, nodeRedInit, 'CHIRPSTACK_PROFILE_RAK10701', 'exports the RAK10701 profile variable');
expectIncludes(nodeRedInitPath, nodeRedInit, 'CHIRPSTACK_PROFILE_RAK10701="$cs_profile_rak10701"', 'exports the resolved RAK10701 profile ID');

const nodeRedSettings = read(nodeRedSettingsPath);
expectIncludes(nodeRedSettingsPath, nodeRedSettings, "const chirpstackEnvPath = '/srv/node-red/.chirpstack.env';", 'has a checked-in ChirpStack env compatibility loader');
expectIncludes(nodeRedSettingsPath, nodeRedSettings, 'protectedKeys', 'protects runtime gateway identity variables from stale env-file overrides');
expectIncludes(nodeRedSettingsPath, nodeRedSettings, 'process.env[key] = value;', 'loads non-protected compatibility values from .chirpstack.env');

const bootstrap = read(chirpstackBootstrapPath);
expectIncludes(chirpstackBootstrapPath, bootstrap, 'writeUciConfig(envVars)', 'persists ChirpStack IDs to UCI');
expectIncludes(chirpstackBootstrapPath, bootstrap, 'CHIRPSTACK_PROFILE_CLOVER: rak10701ProfileId', 'maps Clover compatibility profile to the RAK10701 profile ID');
expectExcludes(chirpstackBootstrapPath, bootstrap, '`application/${sensorsAppId}/device/#`', 'must not rewrite sensor MQTT input topics to installation-specific IDs');
expectExcludes(chirpstackBootstrapPath, bootstrap, '`application/${fieldTesterAppId}/#`', 'must not rewrite field tester MQTT input topics to installation-specific IDs');
expectExcludes(chirpstackBootstrapPath, bootstrap, 'FIXED_APP_ID -> env.get(CHIRPSTACK_APP_ACTUATORS)', 'must not patch STREGA flow code during normal bootstrap');
if (bootstrap.includes('patchSettingsJs();') && !bootstrap.includes("process.env.OSI_BOOTSTRAP_PATCH_SETTINGS === '1'")) {
  fail(`${chirpstackBootstrapPath}: patchSettingsJs() must be removed from normal bootstrap or guarded by OSI_BOOTSTRAP_PATCH_SETTINGS`);
}

const diagnostic = read(diagnosticPath, { optional: true });
if (diagnostic) {
  expectIncludes(diagnosticPath, diagnostic, 'set -eu', 'uses strict shell mode compatible with BusyBox');
  expectIncludes(diagnosticPath, diagnostic, 'redact_value()', 'redacts secrets from diagnostic output');
  expectIncludes(diagnosticPath, diagnostic, 'sqlite3 unavailable', 'degrades gracefully when sqlite3 is not installed');
  expectIncludes(diagnosticPath, diagnostic, 'MQTT IN topics', 'reports Node-RED MQTT input topics');
  expectIncludes(diagnosticPath, diagnostic, 'STREGA downlink', 'reports STREGA downlink source checks');
  expectIncludes(diagnosticPath, diagnostic, 'sync_outbox', 'reports sync outbox counts when sqlite3 is available');
}

if (failures.length) {
  console.error('Communication contract verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Communication contract verification passed');
```

- [ ] **Step 2: Wire the focused verifier into verify-sync-flow.js**

In `scripts/verify-sync-flow.js`, after the file imports and path constants are initialized, add:

```js
execFileSync(process.execPath, [path.resolve(__dirname, 'verify-communication-contract.js')], { stdio: 'inherit' });
```

- [ ] **Step 3: Run verification and confirm it fails for the current regression**

Run:

```bash
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: FAIL with at least one message containing `must not contain hardcoded STREGA app IDs`.

- [ ] **Step 4: Replace the STREGA downlink app-id logic in all three flows**

The STREGA node shape differs by platform. Preserve the existing output count and wiring:

- bcm2712/RPi 5 has three outputs: MQTT downlink, log context, command ACK.
- bcm2709 and bcm2708 have two outputs: MQTT downlink, log context.

For bcm2709 and bcm2708, update the function node named `Build STREGA downlink + emit log ctx`. Replace the `FIXED_APP_ID` declaration with:

```js
const actuatorsAppId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();
if (!actuatorsAppId) {
  const error = 'Missing CHIRPSTACK_APP_ACTUATORS; refusing STREGA downlink';
  node.status({ fill: 'red', shape: 'ring', text: 'missing Actuators app ID' });
  node.error(error, msg);
  const failedLogMsg = {
    _log_ctx: {
      devEui: msg.payload && msg.payload.device && msg.payload.device.devEui
        ? String(msg.payload.device.devEui).trim().toUpperCase()
        : null,
      zone_id: null,
      action: msg.payload && msg.payload.data && msg.payload.data.action
        ? String(msg.payload.data.action).trim().toUpperCase()
        : null,
      duration_minutes: null,
      reason: error,
      result: 'FAILED',
      created_at: new Date().toISOString()
    }
  };
  return [null, failedLogMsg];
}
```

For bcm2712, replace the `FIXED_APP_ID` declaration with:

```js
const actuatorsAppId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();
```

Then insert this guard after the existing `function ack(result, error, extra) { ... }` declaration so the missing-config path can emit the third-output ACK:

```js
if (!actuatorsAppId) {
  const error = 'Missing CHIRPSTACK_APP_ACTUATORS; refusing STREGA downlink';
  node.status({ fill: 'red', shape: 'ring', text: 'missing Actuators app ID' });
  node.error(error, msg);
  const failedLogMsg = {
    _log_ctx: {
      devEui,
      zone_id: Number.isFinite(zoneId) ? zoneId : null,
      action,
      duration_minutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
      reason: error,
      result: 'FAILED',
      created_at: new Date().toISOString()
    }
  };
  return [null, failedLogMsg, ack('FAILED', error)];
}
```

Replace the MQTT topic construction with:

```js
topic: `application/${actuatorsAppId}/device/${devEui}/command/down`,
```

Do not add a fallback UUID.

- [ ] **Step 5: Run flow and sync verification**

Run:

```bash
scripts/check-mqtt-topics.sh
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: both commands exit `0`. `verify-sync-flow.js` no longer reports `FIXED_APP_ID`.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-communication-contract.js scripts/verify-sync-flow.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json
git commit -m "fix: use runtime chirpstack app for strega downlinks"
```

## Task 2: Node-RED Runtime Config Fallback

**Files:**
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`
- Modify: `scripts/verify-communication-contract.js` only if Task 1 did not already add the fallback checks exactly as shown.

- [ ] **Step 1: Confirm the focused verifier covers fallback behavior**

The `scripts/verify-communication-contract.js` script from Task 1 must contain these checks:

```js
expectIncludes(nodeRedInitPath, nodeRedInit, 'load_chirpstack_env_value()', 'defines a per-key .chirpstack.env fallback reader');
expectIncludes(nodeRedInitPath, nodeRedInit, 'resolve_chirpstack_value()', 'resolves UCI first and env fallback second for ChirpStack IDs');
expectIncludes(nodeRedInitPath, nodeRedInit, 'CHIRPSTACK_APP_FIELD_TESTER="$cs_app_field_tester"', 'exports the field tester application ID');
expectIncludes(nodeRedInitPath, nodeRedInit, 'CHIRPSTACK_PROFILE_RAK10701', 'exports the RAK10701 profile variable');
expectIncludes(nodeRedInitPath, nodeRedInit, 'CHIRPSTACK_PROFILE_RAK10701="$cs_profile_rak10701"', 'exports the resolved RAK10701 profile ID');
expectIncludes(nodeRedSettingsPath, nodeRedSettings, "const chirpstackEnvPath = '/srv/node-red/.chirpstack.env';", 'has a checked-in ChirpStack env compatibility loader');
expectIncludes(nodeRedSettingsPath, nodeRedSettings, 'protectedKeys', 'protects runtime gateway identity variables from stale env-file overrides');
expectIncludes(nodeRedSettingsPath, nodeRedSettings, 'process.env[key] = value;', 'loads non-protected compatibility values from .chirpstack.env');
```

- [ ] **Step 2: Run verification and confirm it fails**

Run:

```bash
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: FAIL with missing fallback checks in `node-red.init` and `settings.js`.

- [ ] **Step 3: Add per-key env fallback to node-red.init**

In `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`, add these helpers above `start_service()`:

```sh
CHIRPSTACK_ENV_FILE="/srv/node-red/.chirpstack.env"

load_chirpstack_env_value() {
    local key="$1"
    [ -f "$CHIRPSTACK_ENV_FILE" ] || return 0
    awk -v wanted="$key" '
        /^[[:space:]]*#/ { next }
        /^[[:space:]]*$/ { next }
        {
            line=$0
            sub(/^[[:space:]]*/, "", line)
            split(line, parts, "=")
            if (parts[1] == wanted) {
                sub(/^[^=]*=/, "", line)
                gsub(/^["'\'']|["'\'']$/, "", line)
                print line
                exit
            }
        }
    ' "$CHIRPSTACK_ENV_FILE"
}

resolve_chirpstack_value() {
    local uci_key="$1"
    local env_key="$2"
    local value
    value="$(uci -q get "$uci_key" 2>/dev/null || echo "")"
    if [ -n "$value" ]; then
        printf '%s' "$value"
        logger -t node-red.init "chirpstack config $env_key source=uci"
        return 0
    fi
    value="$(load_chirpstack_env_value "$env_key" 2>/dev/null || echo "")"
    if [ -n "$value" ]; then
        printf '%s' "$value"
        logger -t node-red.init "chirpstack config $env_key source=env-fallback"
        return 0
    fi
    logger -t node-red.init "chirpstack config $env_key source=missing"
    return 0
}
```

Replace the current ChirpStack UCI-only assignments with:

```sh
    local cs_app_sensors=$(resolve_chirpstack_value osi-server.cloud.chirpstack_app_sensors CHIRPSTACK_APP_SENSORS)
    local cs_app_actuators=$(resolve_chirpstack_value osi-server.cloud.chirpstack_app_actuators CHIRPSTACK_APP_ACTUATORS)
    local cs_app_field_tester=$(resolve_chirpstack_value osi-server.cloud.chirpstack_app_field_tester CHIRPSTACK_APP_FIELD_TESTER)
    local cs_profile_kiwi=$(resolve_chirpstack_value osi-server.cloud.chirpstack_profile_kiwi CHIRPSTACK_PROFILE_KIWI)
    local cs_profile_strega=$(resolve_chirpstack_value osi-server.cloud.chirpstack_profile_strega CHIRPSTACK_PROFILE_STREGA)
    local cs_profile_lsn50=$(resolve_chirpstack_value osi-server.cloud.chirpstack_profile_lsn50 CHIRPSTACK_PROFILE_LSN50)
    local cs_profile_clover=$(resolve_chirpstack_value osi-server.cloud.chirpstack_profile_clover CHIRPSTACK_PROFILE_CLOVER)
    local cs_profile_rak10701=$(resolve_chirpstack_value osi-server.cloud.chirpstack_profile_rak10701 CHIRPSTACK_PROFILE_RAK10701)
    local cs_profile_s2120=$(resolve_chirpstack_value osi-server.cloud.chirpstack_profile_s2120 CHIRPSTACK_PROFILE_S2120)
```

Add these exports to `procd_set_param env`:

```sh
        CHIRPSTACK_APP_FIELD_TESTER="$cs_app_field_tester" \
        CHIRPSTACK_PROFILE_RAK10701="$cs_profile_rak10701" \
```

- [ ] **Step 4: Add checked-in settings.js compatibility loader**

At the top of `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`, before `module.exports`, add:

```js
const fs = require('fs');

const chirpstackEnvPath = '/srv/node-red/.chirpstack.env';
const protectedKeys = new Set([
    'DEVICE_EUI',
    'DEVICE_EUI_SOURCE',
    'DEVICE_EUI_CONFIDENCE',
    'DEVICE_EUI_LAST_VERIFIED_AT',
    'LINK_GATEWAY_DEVICE_EUI'
]);

function loadChirpstackEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex <= 0) continue;
        const key = trimmed.slice(0, equalsIndex).trim();
        let value = trimmed.slice(equalsIndex + 1).trim();
        value = value.replace(/^['"]|['"]$/g, '');
        if (!key || protectedKeys.has(key)) continue;
        if (process.env[key]) continue;
        process.env[key] = value;
    }
}

loadChirpstackEnvFile(chirpstackEnvPath);
```

This keeps gateway identity protected and allows Node-RED function `env.get()` calls to see env-file compatibility values when procd did not export them.

- [ ] **Step 5: Run verification**

Run:

```bash
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: exit `0` for fallback checks.

- [ ] **Step 6: Commit**

```bash
git add feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init \
  feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js \
  scripts/verify-communication-contract.js
git commit -m "fix: add chirpstack config fallback for node-red"
```

## Task 3: Bootstrap Persistence Without Flow Mutation

**Files:**
- Modify: `scripts/chirpstack-bootstrap.js`
- Modify: `scripts/verify-communication-contract.js` only if Task 1 did not already add the bootstrap checks exactly as shown.

- [ ] **Step 1: Confirm the focused verifier covers the bootstrap contract**

The `scripts/verify-communication-contract.js` script from Task 1 must contain these checks:

```js
expectIncludes(chirpstackBootstrapPath, bootstrap, 'writeUciConfig(envVars)', 'persists ChirpStack IDs to UCI');
expectIncludes(chirpstackBootstrapPath, bootstrap, 'CHIRPSTACK_PROFILE_CLOVER: rak10701ProfileId', 'maps Clover compatibility profile to the RAK10701 profile ID');
expectExcludes(chirpstackBootstrapPath, bootstrap, '`application/${sensorsAppId}/device/#`', 'must not rewrite sensor MQTT input topics to installation-specific IDs');
expectExcludes(chirpstackBootstrapPath, bootstrap, '`application/${fieldTesterAppId}/#`', 'must not rewrite field tester MQTT input topics to installation-specific IDs');
expectExcludes(chirpstackBootstrapPath, bootstrap, 'FIXED_APP_ID -> env.get(CHIRPSTACK_APP_ACTUATORS)', 'must not patch STREGA flow code during normal bootstrap');
if (bootstrap.includes('patchSettingsJs();') && !bootstrap.includes("process.env.OSI_BOOTSTRAP_PATCH_SETTINGS === '1'")) {
  fail(`${chirpstackBootstrapPath}: patchSettingsJs() must be removed from normal bootstrap or guarded by OSI_BOOTSTRAP_PATCH_SETTINGS`);
}
```

- [ ] **Step 2: Run verification and confirm it fails**

Run:

```bash
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: FAIL on missing `writeUciConfig(envVars)` and current topic/downlink mutation strings.

- [ ] **Step 3: Add UCI persistence helper to bootstrap**

In `scripts/chirpstack-bootstrap.js`, extend the existing child-process import:

```js
const { execSync, execFileSync } = require('child_process');
```

Then add:

```js
function toUciCloudKey(envKey) {
  const mapping = {
    CHIRPSTACK_APP_SENSORS: 'chirpstack_app_sensors',
    CHIRPSTACK_APP_ACTUATORS: 'chirpstack_app_actuators',
    CHIRPSTACK_APP_FIELD_TESTER: 'chirpstack_app_field_tester',
    CHIRPSTACK_PROFILE_KIWI: 'chirpstack_profile_kiwi',
    CHIRPSTACK_PROFILE_STREGA: 'chirpstack_profile_strega',
    CHIRPSTACK_PROFILE_LSN50: 'chirpstack_profile_lsn50',
    CHIRPSTACK_PROFILE_CLOVER: 'chirpstack_profile_clover',
    CHIRPSTACK_PROFILE_RAK10701: 'chirpstack_profile_rak10701',
    CHIRPSTACK_PROFILE_S2120: 'chirpstack_profile_s2120'
  };
  return mapping[envKey] || null;
}

function writeUciConfig(envVars) {
  const commands = [];
  for (const [envKey, value] of Object.entries(envVars)) {
    const uciKey = toUciCloudKey(envKey);
    if (!uciKey || !String(value || '').trim()) continue;
    commands.push(['set', `osi-server.cloud.${uciKey}=${value}`]);
  }
  if (!commands.length) return;
  for (const args of commands) {
    execFileSync('uci', args, { stdio: 'inherit' });
  }
  execFileSync('uci', ['commit', 'osi-server'], { stdio: 'inherit' });
}
```

This keeps the file's existing destructured import style and avoids a `child_process is not defined` runtime error.

- [ ] **Step 4: Map RAK10701 to both profile names**

In the `envVars` object, include both keys:

```js
CHIRPSTACK_PROFILE_CLOVER: rak10701ProfileId,
CHIRPSTACK_PROFILE_RAK10701: rak10701ProfileId,
```

This resolves the current naming mismatch without requiring a separate Clover profile.

- [ ] **Step 5: Stop normal bootstrap from mutating flow behavior**

Replace `updateFlowsJson(sensorsAppId, actuatorsAppId, fieldTesterAppId);` with a validation-only call:

```js
validatePortableFlows();
```

Replace the existing `updateFlowsJson` function with:

```js
function validatePortableFlows() {
  if (!fs.existsSync(CFG.flowsJson)) {
    console.log('  ✓ flows.json not present; skipping portable flow validation');
    return;
  }
  const flows = JSON.parse(fs.readFileSync(CFG.flowsJson, 'utf8'));
  const badTopics = flows
    .filter((node) => node.type === 'mqtt in' && node.topic !== 'application/+/device/+/event/up')
    .map((node) => `${node.name || node.id}: ${node.topic}`);
  const hardcodedDownlinks = flows
    .filter((node) => typeof node.func === 'string' && node.func.includes('FIXED_APP_ID'))
    .map((node) => node.name || node.id);
  if (badTopics.length || hardcodedDownlinks.length) {
    throw new Error([
      'flows.json is not portable.',
      ...badTopics.map((entry) => `bad mqtt topic: ${entry}`),
      ...hardcodedDownlinks.map((entry) => `hardcoded downlink app id: ${entry}`)
    ].join('\n'));
  }
  console.log('  ✓ flows.json portable communication contract verified');
}
```

- [ ] **Step 6: Stop bootstrap settings.js patching**

Remove the normal-bootstrap call to `patchSettingsJs();`. The checked-in `settings.js` loader from Task 2 owns env-file compatibility now.

Keep `patchSettingsJs` only if it is moved behind an explicit compatibility flag such as:

```js
if (process.env.OSI_BOOTSTRAP_PATCH_SETTINGS === '1') {
  patchSettingsJs();
}
```

Normal bootstrap must not patch `settings.js` on every run.

- [ ] **Step 7: Persist env and UCI**

After `writeEnvFile(envVars);`, add:

```js
writeUciConfig(envVars);
```

- [ ] **Step 8: Run verification**

Run:

```bash
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: exit `0`.

- [ ] **Step 9: Commit**

```bash
git add scripts/chirpstack-bootstrap.js scripts/verify-communication-contract.js
git commit -m "fix: persist chirpstack bootstrap config without flow mutation"
```

## Task 4: Deploy Communication Preflight

**Files:**
- Modify: `deploy.sh`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add verification for deploy preflight**

In `scripts/verify-sync-flow.js`, add:

```js
expectFileIncludes('deploy.sh', deployScript, 'run_communication_preflight()', 'runs communication validation before deploy artifacts are copied');
expectFileIncludes('deploy.sh', deployScript, 'scripts/check-mqtt-topics.sh', 'uses the MQTT topic validation script during deploy preflight');
expectFileIncludes('deploy.sh', deployScript, 'scripts/verify-communication-contract.js', 'uses the focused communication contract verifier during deploy preflight');
expectFileIncludes('deploy.sh', deployScript, 'Communication preflight', 'prints a clear deploy preflight section');
```

- [ ] **Step 2: Run verification and confirm it fails**

Run:

```bash
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: FAIL on missing `run_communication_preflight()`.

- [ ] **Step 3: Add deploy preflight**

In `deploy.sh`, add this function after `fetch_required()`:

```sh
run_communication_preflight() {
    echo "--- Communication preflight ---"
    preflight_dir="$TMP_DIR/preflight"
    mkdir -p "$preflight_dir"
    fetch "scripts/check-mqtt-topics.sh" "$preflight_dir/check-mqtt-topics.sh"
    fetch "scripts/verify-communication-contract.js" "$preflight_dir/scripts/verify-communication-contract.js"
    chmod 755 "$preflight_dir/check-mqtt-topics.sh"
    (
        cd "$preflight_dir"
        mkdir -p conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share
        mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share
        mkdir -p conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share
        mkdir -p feeds/chirpstack-openwrt-feed/apps/node-red/files
        mkdir -p scripts
        fetch "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"
        fetch "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json" "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json"
        fetch "conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json" "conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json"
        fetch "feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init" "feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init"
        fetch "feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js" "feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js"
        fetch "scripts/chirpstack-bootstrap.js" "scripts/chirpstack-bootstrap.js"
        sh "$preflight_dir/check-mqtt-topics.sh"
        REPO_ROOT="$preflight_dir" node "$preflight_dir/scripts/verify-communication-contract.js"
    )
    echo "OK"
}
```

Call `run_communication_preflight` immediately after printing `Source: $BASE` and before the first `fetch_required`.

The verifier must live under `$preflight_dir/scripts/` or receive `REPO_ROOT="$preflight_dir"`. This preserves the repo-root assumptions used by `path.resolve(__dirname, '..')` and prevents false missing-file failures in deploy preflight.

If a preflight `fetch` fails, deploy must stop before copying artifacts. Keep the existing `set -eu` behavior and let `curl -fsSLo` fail, but print `--- Communication preflight ---` before the first preflight fetch so the failure is clearly scoped to validation setup rather than a partial deploy.

- [ ] **Step 4: Run local verification**

Run:

```bash
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: exit `0`.

- [ ] **Step 5: Commit**

```bash
git add deploy.sh scripts/verify-sync-flow.js
git commit -m "fix: validate communication contract during deploy"
```

## Task 5: Read-Only Pi Communication Diagnostics

**Files:**
- Create: `scripts/diagnose-pi-communication.sh`
- Modify: `scripts/verify-communication-contract.js`

- [ ] **Step 1: Make the focused verifier require the diagnostic script**

In `scripts/verify-communication-contract.js`, replace the optional diagnostic block from Task 1 with a required read:

```js
const diagnostic = read(diagnosticPath);
expectIncludes(diagnosticPath, diagnostic, 'set -eu', 'uses strict shell mode compatible with BusyBox');
expectIncludes(diagnosticPath, diagnostic, 'redact_value()', 'redacts secrets from diagnostic output');
expectIncludes(diagnosticPath, diagnostic, 'sqlite3 unavailable', 'degrades gracefully when sqlite3 is not installed');
expectIncludes(diagnosticPath, diagnostic, 'MQTT IN topics', 'reports Node-RED MQTT input topics');
expectIncludes(diagnosticPath, diagnostic, 'STREGA downlink', 'reports STREGA downlink source checks');
expectIncludes(diagnosticPath, diagnostic, 'sync_outbox', 'reports sync outbox counts when sqlite3 is available');
```

- [ ] **Step 2: Run verification and confirm it fails**

Run:

```bash
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: FAIL because `scripts/diagnose-pi-communication.sh` does not exist.

- [ ] **Step 3: Create diagnostic script**

Create `scripts/diagnose-pi-communication.sh`:

```sh
#!/bin/sh
set -eu

FLOW_FILE="${FLOW_FILE:-/srv/node-red/flows.json}"
ENV_FILE="${ENV_FILE:-/srv/node-red/.chirpstack.env}"
DB_PATH="${DB_PATH:-/data/db/farming.db}"
INIT_FILE="${INIT_FILE:-/etc/init.d/node-red}"

redact_value() {
    key="$1"
    value="$2"
    case "$key" in
        *KEY*|*PASSWORD*|*TOKEN*|*SECRET*) printf '<redacted>' ;;
        *) printf '%s' "$value" ;;
    esac
}

print_kv() {
    printf '%s=%s\n' "$1" "$2"
}

section() {
    printf '\n== %s ==\n' "$1"
}

read_env_key() {
    key="$1"
    [ -f "$ENV_FILE" ] || return 0
    # Keep this parser aligned with load_chirpstack_env_value() in node-red.init.
    awk -v wanted="$key" '
        /^[[:space:]]*#/ { next }
        /^[[:space:]]*$/ { next }
        {
            line=$0
            sub(/^[[:space:]]*/, "", line)
            split(line, parts, "=")
            if (parts[1] == wanted) {
                sub(/^[^=]*=/, "", line)
                gsub(/^["'\'']|["'\'']$/, "", line)
                print line
                exit
            }
        }
    ' "$ENV_FILE"
}

section "Gateway identity"
if [ -x /usr/libexec/osi-gateway-identity.sh ]; then
    . /usr/libexec/osi-gateway-identity.sh
    gateway_identity_resolve || true
    print_kv DEVICE_EUI "${GATEWAY_IDENTITY_DEVICE_EUI:-}"
    print_kv DEVICE_EUI_SOURCE "${GATEWAY_IDENTITY_DEVICE_EUI_SOURCE:-}"
    print_kv DEVICE_EUI_CONFIDENCE "${GATEWAY_IDENTITY_DEVICE_EUI_CONFIDENCE:-}"
else
    print_kv helper "missing:/usr/libexec/osi-gateway-identity.sh"
fi

section "ChirpStack config"
for pair in \
    "chirpstack_app_sensors CHIRPSTACK_APP_SENSORS" \
    "chirpstack_app_actuators CHIRPSTACK_APP_ACTUATORS" \
    "chirpstack_app_field_tester CHIRPSTACK_APP_FIELD_TESTER" \
    "chirpstack_profile_kiwi CHIRPSTACK_PROFILE_KIWI" \
    "chirpstack_profile_strega CHIRPSTACK_PROFILE_STREGA" \
    "chirpstack_profile_lsn50 CHIRPSTACK_PROFILE_LSN50" \
    "chirpstack_profile_clover CHIRPSTACK_PROFILE_CLOVER" \
    "chirpstack_profile_rak10701 CHIRPSTACK_PROFILE_RAK10701" \
    "chirpstack_profile_s2120 CHIRPSTACK_PROFILE_S2120"
do
    uci_key="${pair% *}"
    env_key="${pair#* }"
    uci_value="$(uci -q get "osi-server.cloud.$uci_key" 2>/dev/null || true)"
    env_value="$(read_env_key "$env_key" 2>/dev/null || true)"
    print_kv "uci.$uci_key" "$(redact_value "$uci_key" "$uci_value")"
    print_kv "env.$env_key" "$(redact_value "$env_key" "$env_value")"
done

section "Node-RED files"
for file in "$FLOW_FILE" "$ENV_FILE" "$INIT_FILE" /srv/node-red/settings.js /srv/node-red/flows_cred.json; do
    if [ -e "$file" ]; then
        print_kv "$file" "present mtime=$(date -r "$file" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || echo unknown)"
    else
        print_kv "$file" "missing"
    fi
done

section "MQTT IN topics"
if [ -f "$FLOW_FILE" ] && command -v node >/dev/null 2>&1; then
    FLOW_FILE="$FLOW_FILE" node <<'NODE'
const fs = require('fs');
const flowFile = process.env.FLOW_FILE;
const flows = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
for (const node of flows.filter((entry) => entry.type === 'mqtt in')) {
  console.log(`${node.id} ${node.name || ''} ${node.topic || ''}`.trim());
}
NODE
else
    print_kv topics "skipped: node or flows.json unavailable"
fi

section "STREGA downlink"
if [ -f "$FLOW_FILE" ] && command -v node >/dev/null 2>&1; then
    FLOW_FILE="$FLOW_FILE" node <<'NODE'
const fs = require('fs');
const flows = JSON.parse(fs.readFileSync(process.env.FLOW_FILE, 'utf8'));
const node = flows.find((entry) => entry.name === 'Build STREGA downlink + emit log ctx');
const source = String(node && node.func || '');
console.log('has_FIXED_APP_ID=' + source.includes('FIXED_APP_ID'));
console.log('uses_CHIRPSTACK_APP_ACTUATORS=' + source.includes("env.get('CHIRPSTACK_APP_ACTUATORS')"));
console.log('has_missing_app_guard=' + source.includes('Missing CHIRPSTACK_APP_ACTUATORS'));
NODE
else
    print_kv strega "skipped: node or flows.json unavailable"
fi

section "SQLite state"
if [ ! -e "$DB_PATH" ]; then
    print_kv sqlite "skipped: database missing"
elif ! command -v sqlite3 >/dev/null 2>&1; then
    print_kv sqlite "skipped: sqlite3 unavailable"
else
    sqlite3 "$DB_PATH" "SELECT 'latest_device_data=' || COALESCE(MAX(recorded_at),'none') FROM device_data;"
    sqlite3 "$DB_PATH" "SELECT 'sync_outbox_pending=' || COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL;"
    sqlite3 "$DB_PATH" "SELECT 'sync_outbox_delivered=' || COUNT(*) FROM sync_outbox WHERE delivered_at IS NOT NULL;"
fi

section "Recent service logs"
if command -v logread >/dev/null 2>&1; then
    logread | grep -Ei 'node-red|chirpstack|mqtt|sync|strega' | tail -n 80 || true
else
    print_kv logs "skipped: logread unavailable"
fi
```

- [ ] **Step 4: Make script executable and run shell syntax check**

Run:

```bash
chmod 755 scripts/diagnose-pi-communication.sh
sh -n scripts/diagnose-pi-communication.sh
```

Expected: `sh -n` exits `0`.

- [ ] **Step 5: Run verification**

Run:

```bash
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Expected: exit `0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/diagnose-pi-communication.sh scripts/verify-communication-contract.js
git commit -m "feat: add pi communication diagnostic script"
```

## Task 6: End-To-End Local Verification And Rollout Handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-04-28-reproducible-pi-communication-design.md` only if the implementation resolves an open question or changes a rollout gate.

- [ ] **Step 1: Run repository communication checks**

Run:

```bash
scripts/check-mqtt-topics.sh
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
sh -n scripts/diagnose-pi-communication.sh
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run frontend build only if flow/API-facing TypeScript changed**

If no TypeScript files changed, skip this step and record `not applicable: no frontend changes`.

If TypeScript files changed, run:

```bash
cd web/react-gui && npm run build
```

Expected: build exits `0`.

- [ ] **Step 3: Inspect git diff for scope discipline**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check
```

Expected: changed files are limited to communication reproducibility scope, and `git diff --check` exits `0`.

- [ ] **Step 4: Prepare live diagnostic commands without running writes**

Record these commands for the rollout operator:

```bash
ssh root@100.93.68.86 'sh -s' < scripts/diagnose-pi-communication.sh > /tmp/kaba100-pre-communication.txt
ssh root@100.81.220.8 'sh -s' < scripts/diagnose-pi-communication.sh > /tmp/silvan-pre-communication.txt
ssh root@100.69.51.98 'sh -s' < scripts/diagnose-pi-communication.sh > /tmp/uganda-pre-communication.txt
```

These commands are read-only diagnostics. They do not deploy, restart services, write UCI, write DB files, or patch flows.

- [ ] **Step 5: Commit any spec update**

If Task 6 changed the design spec, commit it:

```bash
git add docs/superpowers/specs/2026-04-28-reproducible-pi-communication-design.md
git commit -m "docs: update pi communication rollout notes"
```

If Task 6 did not change files, do not create an empty commit.

## Live Rollout Plan After Implementation

Do not write to live Pis until Tasks 1-6 pass locally.

1. Run read-only diagnostics on kaba100, Silvan, and Uganda and save outputs.
2. Choose kaba100 as first write target unless new diagnostics show it is unsuitable.
3. Before any write, create a timestamped backup on the target under `/data/db/backups/osi-os-<timestamp>` including `/data/db/`, `/srv/node-red/`, `/usr/lib/node-red/gui/`, `/etc/init.d/node-red`, `/srv/node-red/flows.json`, and `/srv/node-red/settings.js`.
4. Deploy the narrow artifact set using `deploy.sh`; do not overwrite `/data/db/farming.db`.
5. Do not run `chirpstack-bootstrap.js` against an old live flow before the new portable flow has been deployed. The new bootstrap validation intentionally rejects previously patched live flows that still contain `FIXED_APP_ID`, even if they currently work through an env fallback.
6. If bootstrap is needed after deploy, run it only after deploy preflight has passed and `/srv/node-red/flows.json` has been replaced by the portable flow.
7. Restart Node-RED only inside the approved rollout window.
8. Run post diagnostics and compare to pre diagnostics.
9. Proceed to Silvan only after kaba100 passes local ingest, sync outbox, MQTT client ID, and STREGA runtime app checks.
10. Proceed to Uganda only after one demo Pi passes all post-checks and Uganda preflight shows required app/profile IDs in UCI or `.chirpstack.env`.

Rollback trigger: Node-RED fails to start, local ingest stops, sync outbox delivery regresses, cloud MQTT client ID changes away from `device_<uppercase gateway EUI>`, or STREGA downlink source fails the runtime app-id check.
