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
const journalConfigPaths = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config'
];
const nodeRedSettingsPath = 'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js';
const chirpstackBootstrapPath = 'scripts/chirpstack-bootstrap.js';
const diagnosticPath = 'scripts/diagnose-pi-communication.sh';
const migrationGuardPath = 'scripts/prepare-pi-communication-config.sh';
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

  const sensorDownlinks = nodes.filter((node) => {
    const func = String(node.func || '');
    return func.includes("env.get('CHIRPSTACK_APP_SENSORS')") && func.includes('/command/down');
  });
  for (const node of sensorDownlinks) {
    const func = String(node.func || '');
    expectIncludes(relativePath, func, 'Missing ChirpStack sensors application configuration', `${node.name || node.id} fails loudly when the Sensors app ID is missing`);
  }
}

const nodeRedInit = read(nodeRedInitPath);
expectIncludes(nodeRedInitPath, nodeRedInit, 'load_chirpstack_env_value()', 'defines a per-key .chirpstack.env fallback reader');
expectIncludes(nodeRedInitPath, nodeRedInit, 'resolve_chirpstack_value()', 'resolves UCI first and env fallback second for ChirpStack IDs');
expectIncludes(nodeRedInitPath, nodeRedInit, 'CHIRPSTACK_APP_FIELD_TESTER="$cs_app_field_tester"', 'exports the field tester application ID');
expectIncludes(nodeRedInitPath, nodeRedInit, 'CHIRPSTACK_PROFILE_RAK10701', 'exports the RAK10701 profile variable');
expectIncludes(nodeRedInitPath, nodeRedInit, 'CHIRPSTACK_PROFILE_RAK10701="$cs_profile_rak10701"', 'exports the resolved RAK10701 profile ID');
expectIncludes(nodeRedInitPath, nodeRedInit, 'validate_journal_media_settings()', 'validates journal media settings (failure disables the journal replication worker, not Node-RED startup)');
expectIncludes(nodeRedInitPath, nodeRedInit, 'Number.isSafeInteger', 'rejects unsafe journal byte limits');
expectIncludes(nodeRedInitPath, nodeRedInit, 'readlink -f "$configured_root"', 'resolves the exact journal media root (readlink -f: this platform\'s busybox ships FEATURE_READLINK_FOLLOW but not the separate realpath applet)');
expectIncludes(nodeRedInitPath, nodeRedInit, '[ ! -L "$configured_root" ]', 'rejects a symlink journal media root');
for (const variable of [
  'JOURNAL_PHOTO_CACHE_BYTES="$journal_photo_cache_bytes"',
  'JOURNAL_MIN_FREE_BYTES="$journal_min_free_bytes"',
  'JOURNAL_MEDIA_ROOT="$journal_media_root"'
]) {
  expectIncludes(nodeRedInitPath, nodeRedInit, variable, 'exports validated journal media configuration');
}

for (const configPath of journalConfigPaths) {
  const config = read(configPath);
  const values = Object.fromEntries(Array.from(config.matchAll(
    /^\s*(?:uci )?set osi-server\.cloud\.(journal_photo_cache_bytes|journal_min_free_bytes|journal_media_root)=(.*)$/gm
  )).map((match) => {
    const raw = match[2].trim();
    const unquoted = (/^(['"]).*\1$/.test(raw)) ? raw.slice(1, -1) : raw;
    return [match[1], unquoted];
  }));
  for (const key of ['journal_photo_cache_bytes', 'journal_min_free_bytes']) {
    const value = values[key];
    if (!/^[0-9]+$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
      fail(`${configPath}: ${key} must be a positive safe integer`);
    }
  }
  if (values.journal_media_root !== '/data/journal-media') {
    fail(`${configPath}: journal_media_root must default to /data/journal-media`);
  }
}

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

const diagnostic = read(diagnosticPath);
expectIncludes(diagnosticPath, diagnostic, 'set -eu', 'uses strict shell mode compatible with BusyBox');
expectIncludes(diagnosticPath, diagnostic, 'redact_value()', 'redacts secrets from diagnostic output');
expectIncludes(diagnosticPath, diagnostic, 'sqlite3 unavailable', 'degrades gracefully when sqlite3 is not installed');
expectIncludes(diagnosticPath, diagnostic, 'MQTT IN topics', 'reports Node-RED MQTT input topics');
expectIncludes(diagnosticPath, diagnostic, 'STREGA downlink', 'reports STREGA downlink source checks');
expectIncludes(diagnosticPath, diagnostic, 'sync_outbox', 'reports sync outbox counts when sqlite3 is available');

const migrationGuard = read(migrationGuardPath, { optional: true });
if (migrationGuard) {
  expectIncludes(migrationGuardPath, migrationGuard, 'APPLY=0', 'defaults to dry-run mode');
  expectIncludes(migrationGuardPath, migrationGuard, '--apply', 'requires an explicit apply flag before writing UCI');
  expectIncludes(migrationGuardPath, migrationGuard, 'extract_from_legacy_flow()', 'can read IDs from legacy mutated flows');
  expectIncludes(migrationGuardPath, migrationGuard, 'is_uuid()', 'validates ChirpStack IDs before writing UCI');
  expectIncludes(migrationGuardPath, migrationGuard, 'uci commit osi-server', 'commits populated ChirpStack config to UCI');
  expectIncludes(migrationGuardPath, migrationGuard, 'missing_required=1', 'fails when required config cannot be found');
}

if (failures.length) {
  console.error('Communication contract verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Communication contract verification passed');
