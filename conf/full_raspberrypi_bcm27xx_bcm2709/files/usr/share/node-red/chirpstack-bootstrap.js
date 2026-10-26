#!/usr/bin/env node
/**
 * chirpstack-bootstrap.js  —  OSI OS one-time ChirpStack setup
 *
 * Creates (or reuses if already present):
 *   • 3 ChirpStack applications:  OSI Sensors, OSI Actuators, OSI Field Tester
 *   • 10 device profiles:         KIWI Sensor, CLOVER Sensor, STREGA Valve, STREGA Valve Gen2,
 *                                 Dragino LSN50, RAK Field Tester, SenseCAP S2120, Aqua-Scope LoRain,
 *                                 Milesight UC512, SDI-12 Soil Node
 *   • 1 API key:                  osi-nodered  (used by Node-RED function nodes)
 *
 * Writes results to:
 *   • UCI osi-server.cloud.*             — canonical runtime ChirpStack config
 *   • /srv/node-red/.chirpstack.env      — compatibility fallback for older installs
 *
 * Bootstrap validates flows.json portability but does not mutate flow behavior.
 *
 * Run ONCE on the Pi after first boot:
 *   node /tmp/chirpstack-bootstrap.js
 *
 * Repair mode for a gateway that is already provisioned (deploy.sh runs it):
 *   node /srv/node-red/chirpstack-bootstrap.js --repair-soil-profiles [--repoint-clover-device=<DevEUI> ...]
 * Earlier bootstraps created the Kiwi profile without a codec and wrote
 * CHIRPSTACK_PROFILE_CLOVER as an alias of the RAK field-tester profile, which
 * has no codec either, so Kiwi and Clover uplinks never decoded. Repair mode
 * reuses the existing API key and never runs the full provisioning pass. It
 * attaches the Tektelic codec to the Kiwi and Clover profiles that have none
 * (a codec already there, also one attached by hand, is left alone), gets or
 * creates the Clover profile when CLOVER is unset or aliased, and then rewrites
 * only the chirpstack_profile_clover UCI key and the CHIRPSTACK_PROFILE_CLOVER
 * env line. Each --repoint-clover-device moves that device from the
 * field-tester profile to the Clover profile through the ChirpStack API; a
 * device on any other profile is refused and left alone. Images built before
 * this mode existed ignore the flag and provision fully: run only the
 * /srv/node-red copy that deploy.sh installs.
 *
 * Overridable via environment variables:
 *   CHIRPSTACK_API_URL       ChirpStack gRPC API URL       (default: http://localhost:8080)
 *   CHIRPSTACK_API_KEY       Pre-created API key token     (skips CLI creation)
 *   CS_TENANT_NAME           Tenant name to reuse/create   (default: Open Smart Irrigation)
 *   CS_REGION                LoRaWAN region                (default: EU868)
 *   ENV_FILE                 Env file path                 (default: /srv/node-red/.chirpstack.env)
 *   SETTINGS_JS              Node-RED settings.js path     (default: /srv/node-red/settings.js)
 *   FLOWS_JSON               Node-RED flows.json path      (default: /srv/node-red/flows.json)
 *
 * App name overrides (use to reuse existing apps instead of creating OSI-prefixed ones):
 *   CS_APP_SENSORS_NAME      (default: "OSI Sensors")
 *   CS_APP_ACTUATORS_NAME    (default: "OSI Actuators")
 *   CS_APP_FIELD_TESTER_NAME (default: "OSI Field Tester")
 *
 * Profile name overrides (use to reuse an existing device profile):
 *   CS_PROFILE_KIWI_NAME     (default: "OSI KIWI Sensor")
 *   CS_PROFILE_CLOVER_NAME   (default: "OSI CLOVER Sensor")
 *   CS_PROFILE_STREGA_NAME   (default: "OSI STREGA Valve")
 *   CS_PROFILE_STREGA_GEN2_NAME (default: "OSI STREGA Valve Gen2")
 *   CS_PROFILE_LSN50_NAME    (default: "OSI Dragino LSN50")
 *   CS_PROFILE_RAK_NAME      (default: "OSI RAK Field Tester")
 *   CS_PROFILE_S2120_NAME    (default: "OSI SenseCAP S2120")
 *   CS_PROFILE_LORAIN_NAME   (default: "OSI Aqua-Scope LoRain")
 *   CS_PROFILE_UC512_NAME    (default: "OSI Milesight UC512")
 *   CS_PROFILE_SDI12_NAME    (default: "OSI SDI-12 Soil Node")
 *   STREGA_CODEC_PATH        (default: "/srv/node-red/codecs/strega_gen1_decoder.js")
 *   STREGA_GEN2_CODEC_PATH   (default: "/srv/node-red/codecs/strega_gen2_decoder.js")
 *   LSN50_CODEC_PATH         (default: "/srv/node-red/codecs/dragino_lsn50_decoder.js")
 *   S2120_CODEC_PATH         (default: "/srv/node-red/codecs/sensecap_s2120_decoder.js")
 *   LORAIN_CODEC_PATH        (default: "/srv/node-red/codecs/aquascope_lorain_decoder.js")
 *   UC512_CODEC_PATH         (default: "/srv/node-red/codecs/milesight_uc512_decoder.js")
 *   SDI12_CODEC_PATH         (default: "/srv/node-red/codecs/dragino_sdi12_decoder.js")
 *   TEKTELIC_CODEC_PATH      (default: "/srv/node-red/codecs/tektelic_agriculture_decoder.js")
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

function loadChirpStackHelper() {
  const candidates = [
    '/srv/node-red/node_modules/osi-chirpstack-helper',
    '/srv/node-red/osi-chirpstack-helper',
    '/usr/share/node-red/node_modules/osi-chirpstack-helper',
    path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'node_modules', 'osi-chirpstack-helper'),
    path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share', 'node-red', 'osi-chirpstack-helper')
  ];
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Unable to load osi-chirpstack-helper.\n${failures.join('\n')}`);
}

let chirpstack;

const CFG = {
  url: process.env.CHIRPSTACK_API_URL || process.env.CS_URL || 'http://localhost:8080',
  apiKey: process.env.CHIRPSTACK_API_KEY || process.env.CS_API_KEY || '',
  tenantName: process.env.CS_TENANT_NAME || 'Open Smart Irrigation',
  region: process.env.CS_REGION || 'EU868',
  envFile: process.env.ENV_FILE || '/srv/node-red/.chirpstack.env',
  settingsJs: process.env.SETTINGS_JS || '/srv/node-red/settings.js',
  flowsJson: process.env.FLOWS_JSON || '/srv/node-red/flows.json',
  appSensorsName: process.env.CS_APP_SENSORS_NAME || 'OSI Sensors',
  appActuatorsName: process.env.CS_APP_ACTUATORS_NAME || 'OSI Actuators',
  appFieldTesterName: process.env.CS_APP_FIELD_TESTER_NAME || 'OSI Field Tester',
  profileKiwiName: process.env.CS_PROFILE_KIWI_NAME || 'OSI KIWI Sensor',
  profileCloverName: process.env.CS_PROFILE_CLOVER_NAME || 'OSI CLOVER Sensor',
  profileStregaName: process.env.CS_PROFILE_STREGA_NAME || 'OSI STREGA Valve',
  profileStregaGen2Name: process.env.CS_PROFILE_STREGA_GEN2_NAME || 'OSI STREGA Valve Gen2',
  profileLsn50Name: process.env.CS_PROFILE_LSN50_NAME || 'OSI Dragino LSN50',
  profileRakName: process.env.CS_PROFILE_RAK_NAME || 'OSI RAK Field Tester',
  profileS2120Name: process.env.CS_PROFILE_S2120_NAME || 'OSI SenseCAP S2120',
  profileLorainName: process.env.CS_PROFILE_LORAIN_NAME || 'OSI Aqua-Scope LoRain',
  profileUc512Name: process.env.CS_PROFILE_UC512_NAME || 'OSI Milesight UC512',
  profileSdi12Name: process.env.CS_PROFILE_SDI12_NAME || 'OSI SDI-12 Soil Node',
  stregaCodecPath: process.env.STREGA_CODEC_PATH || '/srv/node-red/codecs/strega_gen1_decoder.js',
  stregaGen2CodecPath: process.env.STREGA_GEN2_CODEC_PATH || '/srv/node-red/codecs/strega_gen2_decoder.js',
  lsn50CodecPath: process.env.LSN50_CODEC_PATH || '/srv/node-red/codecs/dragino_lsn50_decoder.js',
  s2120CodecPath: process.env.S2120_CODEC_PATH || '/srv/node-red/codecs/sensecap_s2120_decoder.js',
  lorainCodecPath: process.env.LORAIN_CODEC_PATH || '/srv/node-red/codecs/aquascope_lorain_decoder.js',
  uc512CodecPath: process.env.UC512_CODEC_PATH || '/srv/node-red/codecs/milesight_uc512_decoder.js',
  sdi12CodecPath: process.env.SDI12_CODEC_PATH || '/srv/node-red/codecs/dragino_sdi12_decoder.js',
  tektelicCodecPath: process.env.TEKTELIC_CODEC_PATH || '/srv/node-red/codecs/tektelic_agriculture_decoder.js'
};

const KIWI_PROFILE_DESCRIPTION = 'Kiwi soil moisture & temperature (LoRaWAN 1.0.3 OTAA)';
const CLOVER_PROFILE_DESCRIPTION = 'TEKTELIC CLOVER agriculture sensor (LoRaWAN 1.0.3 OTAA)';

const ENV_LOADER_MARKER = '// [OSI] chirpstack env loader';

function listItemsToObjects(items) {
  return items.map((item) => chirpstack.listItemToObject(item));
}

async function getOrCreateTenant(client) {
  const tenants = listItemsToObjects(await client.listTenants());
  const named = tenants.find((tenant) => tenant.name === CFG.tenantName);
  if (named) {
    console.log(`  ✓ Tenant exists: "${named.name}" (${named.id})`);
    return named.id;
  }
  if (tenants.length > 0) {
    console.log(`  ✓ Reusing first tenant: "${tenants[0].name}" (${tenants[0].id})`);
    return tenants[0].id;
  }
  const created = await client.createTenant({
    name: CFG.tenantName,
    description: 'OSI bootstrap tenant',
    canHaveGateways: true,
    maxGatewayCount: 0,
    maxDeviceCount: 0,
    privateGatewaysUp: false,
    privateGatewaysDown: false
  });
  console.log(`  + Tenant created: "${CFG.tenantName}" (${created.getId()})`);
  return created.getId();
}

async function getOrCreateApp(client, tenantId, name, description) {
  const apps = listItemsToObjects(await client.listApplications(tenantId));
  const existing = apps.find((app) => app.name === name);
  if (existing) {
    console.log(`  ✓ App exists: "${name}" (${existing.id})`);
    return existing.id;
  }
  const created = await client.createApplication({ tenantId, name, description });
  console.log(`  + App created: "${name}" (${created.getId()})`);
  return created.getId();
}

function normalizeCodecScript(payloadCodecScript) {
  return String(payloadCodecScript || '').replace(/\r\n/g, '\n').trim();
}

function readCodecScript(codecPath, label) {
  try {
    const payloadCodecScript = fs.readFileSync(codecPath, 'utf8');
    console.log(`  ✓ ${label} codec loaded from ${codecPath} (${payloadCodecScript.length} bytes)`);
    return payloadCodecScript;
  } catch (e) {
    console.log(`  ⚠ ${label} codec not found at ${codecPath} — creating profile without codec`);
    return '';
  }
}

async function getOrCreateProfileWithCodec(client, tenantId, name, description, payloadCodecScript, options = {}) {
  const desiredCodecScript = normalizeCodecScript(payloadCodecScript);
  const autoDetectMeasurements = options.autoDetectMeasurements !== undefined
    ? Boolean(options.autoDetectMeasurements)
    : desiredCodecScript.length > 0;
  const profiles = listItemsToObjects(await client.listDeviceProfiles(tenantId));
  const existing = profiles.find((profile) => profile.name === name);
  if (existing) {
    if (desiredCodecScript) {
      const existingProfile = await client.getDeviceProfile(existing.id);
      // keepExistingCodec: a profile that already runs a JS codec keeps it. Used
      // for the Kiwi and Clover profiles, which older gateways set up by hand
      // with the vendor's own decoder; replacing it would change the decoded
      // field names under devices that already report.
      if (options.keepExistingCodec && existingProfile
        && Number(existingProfile.getPayloadCodecRuntime()) === 2
        && normalizeCodecScript(existingProfile.getPayloadCodecScript())) {
        console.log(`  ✓ Profile exists: "${name}" (${existing.id}), keeps its own codec`);
        return existing.id;
      }
      const existingCodecRuntime = existingProfile && typeof existingProfile.getPayloadCodecRuntime === 'function'
        ? Number(existingProfile.getPayloadCodecRuntime())
        : null;
      const existingCodecScript = existingProfile && typeof existingProfile.getPayloadCodecScript === 'function'
        ? normalizeCodecScript(existingProfile.getPayloadCodecScript())
        : '';
      const existingAutoDetect = existingProfile && typeof existingProfile.getAutoDetectMeasurements === 'function'
        ? Boolean(existingProfile.getAutoDetectMeasurements())
        : false;
      const needsCodecRepair = existingCodecRuntime !== 2
        || existingCodecScript !== desiredCodecScript
        || existingAutoDetect !== autoDetectMeasurements;

      if (needsCodecRepair) {
        await client.updateDeviceProfile({
          id: existing.id,
          tenantId,
          name,
          description,
          region: CFG.region,
          uplinkInterval: 3600,
          deviceStatusReqInterval: 1,
          autoDetectMeasurements,
          payloadCodecScript: desiredCodecScript
        });
        console.log(`  ~ Profile updated: "${name}" (${existing.id})`);
        return existing.id;
      }
    }
    console.log(`  ✓ Profile exists: "${name}" (${existing.id})`);
    return existing.id;
  }
  const created = await client.createDeviceProfile({
    tenantId,
    name,
    description,
    region: CFG.region,
    uplinkInterval: 3600,
    deviceStatusReqInterval: 1,
    autoDetectMeasurements,
    payloadCodecScript: desiredCodecScript || undefined
  });
  console.log(`  + Profile created: "${name}" (${created.getId()})`);
  return created.getId();
}

async function getOrCreateProfile(client, tenantId, name, description) {
  const profiles = listItemsToObjects(await client.listDeviceProfiles(tenantId));
  const existing = profiles.find((profile) => profile.name === name);
  if (existing) {
    console.log(`  ✓ Profile exists: "${name}" (${existing.id})`);
    return existing.id;
  }
  const created = await client.createDeviceProfile({
    tenantId,
    name,
    description,
    region: CFG.region,
    uplinkInterval: 3600,
    deviceStatusReqInterval: 1
  });
  console.log(`  + Profile created: "${name}" (${created.getId()})`);
  return created.getId();
}

async function createApiKeyViaCLI() {
  console.log('  + Creating API key via CLI (chirpstack create-api-key) ...');
  let out;
  try {
    // stderr is captured, never inherited: without an explicit pipe the child's
    // stderr would go straight to this process's stderr, past the redaction.
    out = execSync('chirpstack -c /var/etc/chirpstack create-api-key --name osi-nodered', {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (error) {
    const status = error && Number.isInteger(error.status) && error.status >= 1 && error.status <= 255
      ? `, exit status ${error.status}`
      : '';
    throw new Error(`CLI create-api-key failed (command error${status})`);
  }

  const match = out.match(/^token:\s*(.+)$/m);
  const token = match ? match[1].trim() : '';
  // A token is printable ASCII with no spaces. Anything else (an ANSI colour
  // code, a tab, a non-ASCII byte) would make grpc-js reject the authorization
  // header with an error message that quotes the whole token.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error('CLI create-api-key failed (invalid output)');
  }
  console.log('  ✓ API key created via CLI');
  return token;
}

function normalizeGatewayEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return null;
  if (raw.length === 16) return raw === '0101010101010101' ? null : raw;
  if (raw.length === 12) return `${raw.slice(0, 6)}FFFE${raw.slice(6)}`;
  return null;
}

function readGatewayIdentityViaHelper() {
  try {
    const helper = '/usr/libexec/osi-gateway-identity.sh';
    if (!fs.existsSync(helper)) return null;
    const output = execSync(`${helper} resolve`, { timeout: 5000 }).toString('utf8');
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    const values = Object.fromEntries(lines.map((line) => {
      const idx = line.indexOf('=');
      return idx > 0 ? [line.slice(0, idx), line.slice(idx + 1)] : [line, ''];
    }));
    const deviceEui = normalizeGatewayEui(values.DEVICE_EUI);
    if (!deviceEui) return null;
    return {
      deviceEui,
      source: String(values.DEVICE_EUI_SOURCE || '').trim() || 'persisted',
      confidence: String(values.DEVICE_EUI_CONFIDENCE || '').trim() || 'provisional',
      lastVerifiedAt: String(values.DEVICE_EUI_LAST_VERIFIED_AT || '').trim() || null,
    };
  } catch (_) {
    return null;
  }
}

function detectGatewayEui() {
  const identity = readGatewayIdentityViaHelper();
  return identity ? identity.deviceEui : null;
}

const CREDENTIAL_ENV_EXIT = 74;
const CREDENTIAL_ENV_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ELOOP', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EMFILE',
  'ENFILE', 'ENOMEM', 'ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'EBADF', 'EINVAL',
  'ENOTEMPTY', 'EXDEV', 'EINTR', 'ENOSYS'
]);
const CREDENTIAL_ENV_PHASES = new Set([
  'validate', 'metadata', 'read', 'decode', 'encode', 'stage', 'publish',
  'flush', 'verify', 'cleanup'
]);

class CredentialEnvError extends Error {
  constructor(fields = {}) {
    super('Credential env-file operation failed');
    this.name = 'CredentialEnvError';
    this.exitStatus = CREDENTIAL_ENV_EXIT;
    this.operation = fields.operation || 'credentialEnv';
    this.phase = CREDENTIAL_ENV_PHASES.has(fields.phase) ? fields.phase : 'validate';
    this.reason = fields.reason || 'OS_ERROR';
    this.osCode = fields.osCode || null;
    this.published = Boolean(fields.published);
    this.publication = fields.publication === 'rename' || fields.publication === 'link' ? fields.publication : null;
    this.cleanupErrors = Array.isArray(fields.cleanupErrors) ? fields.cleanupErrors.slice() : [];
  }
}

class UsageError extends Error {
  constructor() {
    super('Invalid ChirpStack bootstrap arguments');
    this.name = 'UsageError';
    this.exitStatus = 2;
  }
}

function credentialOsCode(error) {
  return error && CREDENTIAL_ENV_CODES.has(error.code) ? error.code : 'IO_FAILED';
}

function credentialError(operation, phase, error, reason, state) {
  if (error instanceof CredentialEnvError) {
    if (state && state.published) error.published = true;
    if (state && state.publication) error.publication = state.publication;
    return error;
  }
  return new CredentialEnvError({
    operation,
    phase,
    reason: reason || 'OS_ERROR',
    osCode: error ? credentialOsCode(error) : null,
    published: Boolean(state && state.published),
    publication: state && state.publication
  });
}

function credentialRecord(error, operation, phase, state) {
  const safe = credentialError(operation, phase, error, 'OS_ERROR', state);
  return {
    operation: safe.operation,
    phase: safe.phase,
    reason: safe.reason,
    osCode: safe.osCode,
    published: safe.published,
    publication: safe.publication
  };
}

function addPublicationState(error, state) {
  if (error instanceof CredentialEnvError && state) {
    error.published = error.published || state.published;
    if (state.publication) error.publication = state.publication;
  }
  return error;
}

function finishCredentialScope(result, primary, cleanupErrors, state, operation) {
  if (primary) addPublicationState(primary, state);
  if (cleanupErrors.length) {
    if (!(primary instanceof CredentialEnvError)) {
      primary = new CredentialEnvError({
        operation,
        phase: 'cleanup',
        reason: 'OS_ERROR',
        published: Boolean(state && state.published),
        publication: state && state.publication,
        cleanupErrors: primary ? [{ reason: 'NON_CREDENTIAL_FAILURE' }] : []
      });
    }
    primary.cleanupErrors.push(...cleanupErrors);
    addPublicationState(primary, state);
    throw primary;
  }
  if (primary) throw primary;
  return result;
}

function credentialCall(directory, operation, phase, callback, reason) {
  try {
    return callback();
  } catch (error) {
    throw credentialError(operation, phase, error, reason, directory && directory.state);
  }
}

function collectCredentialCleanup(errors, directory, operation, callback) {
  try {
    callback();
  } catch (error) {
    errors.push(credentialRecord(error, operation, 'cleanup', directory && directory.state));
  }
}

function sameIdentity(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

function regularSingleLink(stat) {
  return Boolean(stat && stat.isFile() && stat.nlink === 1);
}

function checkedEnvStat(stat) {
  return Boolean(regularSingleLink(stat) && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o7777) === 0o600);
}

function withEnvDirectory(callback, operation = 'withEnvDirectory') {
  const state = { published: false, publication: null };
  const openFds = [];
  const cleanupErrors = [];
  let result;
  let primary = null;
  let phase = 'validate';
  try {
    if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) {
      throw new CredentialEnvError({ operation, phase: 'validate', reason: 'ROOT_REQUIRED', published: state.published, publication: state.publication });
    }
    if (typeof fs.constants.O_NOFOLLOW !== 'number' || typeof fs.constants.O_DIRECTORY !== 'number') {
      throw new CredentialEnvError({ operation, phase: 'validate', reason: 'PRIMITIVE_UNAVAILABLE' });
    }
    const absolute = path.resolve(CFG.envFile);
    const procStat = credentialCall(null, operation, 'validate', () => fs.statSync('/proc/self/fd'));
    if (!procStat.isDirectory()) throw new CredentialEnvError({ operation, phase: 'validate', reason: 'PRIMITIVE_UNAVAILABLE' });
    const parentPath = path.dirname(absolute);
    const components = parentPath === '/' ? [] : parentPath.slice(1).split(path.sep);
    let currentFd = credentialCall(null, operation, phase, () => fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY));
    openFds.push(currentFd);
    const rootStat = credentialCall(null, operation, 'metadata', () => fs.fstatSync(currentFd));
    if (!rootStat.isDirectory()) throw new CredentialEnvError({ operation, phase: 'metadata', reason: 'UNSAFE_ENTRY' });
    for (const component of components) {
      phase = 'validate';
      const nextFd = credentialCall(null, operation, phase, () =>
        fs.openSync('/proc/self/fd/' + currentFd + '/' + component,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
      openFds.push(nextFd);
      phase = 'metadata';
      const nextStat = credentialCall(null, operation, phase, () => fs.fstatSync(nextFd));
      if (!nextStat.isDirectory()) throw new CredentialEnvError({ operation, phase, reason: 'UNSAFE_ENTRY' });
      const previousFd = currentFd;
      currentFd = nextFd;
      phase = 'cleanup';
      credentialCall(null, operation, phase, () => fs.closeSync(previousFd));
      const previousIndex = openFds.indexOf(previousFd);
      if (previousIndex >= 0) openFds.splice(previousIndex, 1);
    }
    const directory = {
      dirFd: currentFd,
      dirPath: '/proc/self/fd/' + currentFd,
      name: path.basename(absolute),
      state
    };
    phase = 'validate';
    result = callback(directory);
  } catch (error) {
    primary = error;
  }
  for (const fd of openFds.slice().reverse()) {
    collectCredentialCleanup(cleanupErrors, { state }, operation, () => fs.closeSync(fd));
    const index = openFds.indexOf(fd);
    if (index >= 0) openFds.splice(index, 1);
  }
  return finishCredentialScope(result, primary, cleanupErrors, state, operation);
}

function secureExistingEnvFile(directory, name, required = false, operation = 'secureExistingEnvFile') {
  let fd = null;
  let primary = null;
  let snapshot = null;
  const cleanupErrors = [];
  let phase = 'validate';
  try {
    const target = directory.dirPath + '/' + name;
    let namedStat;
    try {
      namedStat = fs.lstatSync(target);
    } catch (error) {
      if (error && error.code === 'ENOENT' && !required) return null;
      if (error && error.code === 'ENOENT' && required) {
        throw new CredentialEnvError({ operation, phase: 'validate', reason: 'REQUIRED_FILE_MISSING', published: directory.state.published, publication: directory.state.publication });
      }
      throw error;
    }
    if (!regularSingleLink(namedStat)) throw new CredentialEnvError({ operation, phase: 'validate', reason: 'UNSAFE_ENTRY' });
    phase = 'read';
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    phase = 'metadata';
    let stat = fs.fstatSync(fd);
    if (!regularSingleLink(stat) || !sameIdentity(namedStat, stat)) {
      throw new CredentialEnvError({ operation, phase, reason: 'UNSAFE_ENTRY' });
    }
    let metadataChanged = false;
    if ((stat.mode & 0o7777) !== 0o600) {
      fs.fchmodSync(fd, 0o600);
      metadataChanged = true;
    }
    if (stat.uid !== 0 || stat.gid !== 0) {
      fs.fchownSync(fd, 0, 0);
      fs.fchmodSync(fd, 0o600);
      metadataChanged = true;
    }
    stat = fs.fstatSync(fd);
    if (!checkedEnvStat(stat)) throw new CredentialEnvError({ operation, phase: 'metadata', reason: 'UNSAFE_ENTRY' });
    if (metadataChanged) {
      phase = 'flush';
      fs.fsyncSync(fd);
    }
    phase = 'verify';
    const stillNamed = fs.lstatSync(target);
    if (!sameIdentity(stillNamed, stat) || !checkedEnvStat(stillNamed)) {
      throw new CredentialEnvError({ operation, phase, reason: 'SNAPSHOT_CHANGED' });
    }
    const beforeRead = fs.fstatSync(fd);
    phase = 'read';
    const bytes = fs.readFileSync(fd);
    const afterRead = fs.fstatSync(fd);
    if (!Buffer.isBuffer(bytes) || bytes.length !== beforeRead.size
      || beforeRead.dev !== afterRead.dev || beforeRead.ino !== afterRead.ino
      || beforeRead.size !== afterRead.size || beforeRead.mtimeMs !== afterRead.mtimeMs
      || beforeRead.ctimeMs !== afterRead.ctimeMs) {
      throw new CredentialEnvError({ operation, phase, reason: 'SNAPSHOT_CHANGED' });
    }
    snapshot = { fd, stat: afterRead, bytes };
    fd = null;
  } catch (error) {
    primary = error instanceof CredentialEnvError ? error : credentialError(operation, phase, error, null, directory.state);
  }
  if (fd !== null) collectCredentialCleanup(cleanupErrors, directory, operation, () => fs.closeSync(fd));
  return finishCredentialScope(snapshot, primary, cleanupErrors, directory.state, operation);
}

function assertEnvSnapshot(directory, name, snapshot, operation = 'assertEnvSnapshot') {
  const target = directory.dirPath + '/' + name;
  let current;
  try {
    current = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT' && snapshot === null) return true;
    if (error && error.code === 'ENOENT') throw new CredentialEnvError({ operation, phase: 'verify', reason: 'SNAPSHOT_CHANGED', published: directory.state.published, publication: directory.state.publication });
    throw credentialError(operation, 'verify', error, null, directory.state);
  }
  if (snapshot === null || !checkedEnvStat(current) || !sameIdentity(current, snapshot.stat)
    || current.size !== snapshot.stat.size || current.mtimeMs !== snapshot.stat.mtimeMs
    || current.ctimeMs !== snapshot.stat.ctimeMs) {
    throw new CredentialEnvError({ operation, phase: 'verify', reason: 'SNAPSHOT_CHANGED', published: directory.state.published, publication: directory.state.publication });
  }
  return true;
}

function decodeEnvUtf8(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new CredentialEnvError({ operation: 'decodeEnvUtf8', phase: 'decode', reason: 'CONTENT_TYPE_INVALID' });
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new CredentialEnvError({ operation: 'decodeEnvUtf8', phase: 'decode', reason: 'NON_LOSSLESS_UTF8' });
  }
  return text;
}

function publishEnvContent(directory, name, content, snapshot, publication) {
  const operation = 'publishEnvContent';
  const state = directory.state;
  if (publication !== 'replace' && publication !== 'create-only') {
    throw new CredentialEnvError({ operation, phase: 'validate', reason: 'CONTENT_TYPE_INVALID', published: state.published, publication: state.publication });
  }
  let candidateBytes;
  if (Buffer.isBuffer(content)) candidateBytes = Buffer.from(content);
  else if (typeof content === 'string') {
    candidateBytes = Buffer.from(content, 'utf8');
    if (candidateBytes.toString('utf8') !== content) throw new CredentialEnvError({ operation, phase: 'encode', reason: 'NON_LOSSLESS_UTF8', published: state.published, publication: state.publication });
  } else {
    throw new CredentialEnvError({ operation, phase: 'encode', reason: 'CONTENT_TYPE_INVALID', published: state.published, publication: state.publication });
  }

  const cleanupErrors = [];
  let primary = null;
  let result;
  let stageDirFd = null;
  let stageFd = null;
  let publishedFd = null;
  let stagePath = null;
  let stageName = null;
  let stageIdentity = null;
  let stageFileIdentity = null;
  let stageFileOwned = false;
  let phase = 'stage';
  try {
    stagePath = fs.mkdtempSync(directory.dirPath + '/.' + name + '.tmp-');
    stageName = path.basename(stagePath);
    stageDirFd = fs.openSync(directory.dirPath + '/' + stageName, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const namedStage = fs.lstatSync(directory.dirPath + '/' + stageName);
    let stageStat = fs.fstatSync(stageDirFd);
    if (!stageStat.isDirectory() || !sameIdentity(namedStage, stageStat)) throw new CredentialEnvError({ operation, phase: 'stage', reason: 'STAGE_CHANGED', published: state.published, publication: state.publication });
    stageIdentity = stageStat;
    fs.fchownSync(stageDirFd, 0, 0);
    fs.fchmodSync(stageDirFd, 0o700);
    stageStat = fs.fstatSync(stageDirFd);
    if (!stageStat.isDirectory() || !sameIdentity(stageIdentity, stageStat)
      || stageStat.uid !== 0 || stageStat.gid !== 0 || (stageStat.mode & 0o7777) !== 0o700) {
      throw new CredentialEnvError({ operation, phase: 'stage', reason: 'STAGE_CHANGED', published: state.published, publication: state.publication });
    }
    stageIdentity = stageStat;
    const stageFdPath = '/proc/self/fd/' + stageDirFd;
    phase = 'stage';
    stageFd = fs.openSync(stageFdPath + '/env',
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600);
    stageFileOwned = true;
    let initial = fs.fstatSync(stageFd);
    stageFileIdentity = initial;
    if (!regularSingleLink(initial)) {
      throw new CredentialEnvError({ operation, phase: 'stage', reason: 'STAGE_CHANGED', published: state.published, publication: state.publication });
    }
    fs.fchownSync(stageFd, 0, 0);
    fs.fchmodSync(stageFd, 0o600);
    initial = fs.fstatSync(stageFd);
    if (!regularSingleLink(initial) || !sameIdentity(stageFileIdentity, initial)
      || initial.uid !== 0 || initial.gid !== 0 || (initial.mode & 0o7777) !== 0o600) {
      throw new CredentialEnvError({ operation, phase: 'stage', reason: 'STAGE_CHANGED', published: state.published, publication: state.publication });
    }
    fs.writeFileSync(stageFd, candidateBytes);
    const written = fs.fstatSync(stageFd);
    if (written.size !== candidateBytes.length) throw new CredentialEnvError({ operation, phase: 'stage', reason: 'BYTE_COUNT_MISMATCH', published: state.published, publication: state.publication });
    phase = 'flush';
    fs.fsyncSync(stageFd);
    stageFileIdentity = fs.fstatSync(stageFd);
    if (!checkedEnvStat(stageFileIdentity) || stageFileIdentity.size !== candidateBytes.length) {
      throw new CredentialEnvError({ operation, phase: 'verify', reason: 'STAGE_CHANGED', published: state.published, publication: state.publication });
    }
    fs.closeSync(stageFd);
    stageFd = null;
    assertEnvSnapshot(directory, name, snapshot, operation);
    const livePath = directory.dirPath + '/' + name;
    phase = 'publish';
    if (snapshot !== null) {
      fs.renameSync(stageFdPath + '/env', livePath);
      state.published = true;
      state.publication = 'rename';
      stageFileOwned = false;
    } else {
      fs.linkSync(stageFdPath + '/env', livePath);
      state.published = true;
      state.publication = 'link';
      fs.unlinkSync(stageFdPath + '/env');
      stageFileOwned = false;
    }
    phase = 'verify';
    publishedFd = fs.openSync(livePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const finalStat = fs.fstatSync(publishedFd);
    if (!checkedEnvStat(finalStat) || !sameIdentity(finalStat, stageFileIdentity)
      || finalStat.size !== candidateBytes.length || !fs.readFileSync(publishedFd).equals(candidateBytes)) {
      throw new CredentialEnvError({ operation, phase, reason: 'BYTE_CONTENT_MISMATCH', published: state.published, publication: state.publication });
    }
    phase = 'flush';
    fs.fsyncSync(directory.dirFd);
    result = true;
  } catch (error) {
    primary = error instanceof CredentialEnvError ? error : credentialError(operation, phase, error, null, state);
  }

  if (stageFd !== null) collectCredentialCleanup(cleanupErrors, directory, operation, () => fs.closeSync(stageFd));
  if (publishedFd !== null) collectCredentialCleanup(cleanupErrors, directory, operation, () => fs.closeSync(publishedFd));
  if (stageFileOwned && stageDirFd !== null) {
    collectCredentialCleanup(cleanupErrors, directory, operation, () => {
      const candidate = '/proc/self/fd/' + stageDirFd + '/env';
      const current = fs.lstatSync(candidate);
      if (!stageFileIdentity || !sameIdentity(current, stageFileIdentity)) {
        throw new CredentialEnvError({ operation, phase: 'cleanup', reason: 'STAGE_CHANGED', published: state.published, publication: state.publication });
      }
      fs.unlinkSync(candidate);
    });
  }
  if (stageDirFd !== null) {
    collectCredentialCleanup(cleanupErrors, directory, operation, () => {
      const named = fs.lstatSync(directory.dirPath + '/' + stageName);
      const opened = fs.fstatSync(stageDirFd);
      if (!stageIdentity || !sameIdentity(named, opened)) {
        throw new CredentialEnvError({ operation, phase: 'cleanup', reason: 'STAGE_CHANGED', published: state.published, publication: state.publication });
      }
      fs.closeSync(stageDirFd);
      stageDirFd = null;
      fs.rmdirSync(directory.dirPath + '/' + stageName);
    });
    if (stageDirFd !== null) collectCredentialCleanup(cleanupErrors, directory, operation, () => fs.closeSync(stageDirFd));
  }
  return finishCredentialScope(result, primary, cleanupErrors, state, operation);
}

function withEnvSnapshots(directory, operation, callback, requireLive = false) {
  let live = null;
  let backup = null;
  let result;
  let primary = null;
  const cleanupErrors = [];
  try {
    live = secureExistingEnvFile(directory, directory.name, requireLive, operation);
    backup = secureExistingEnvFile(directory, directory.name + '.pre-gen2', false, operation);
    result = callback(live, backup);
  } catch (error) {
    primary = error;
  }
  if (live) collectCredentialCleanup(cleanupErrors, directory, operation, () => fs.closeSync(live.fd));
  if (backup) collectCredentialCleanup(cleanupErrors, directory, operation, () => fs.closeSync(backup.fd));
  return finishCredentialScope(result, primary, cleanupErrors, directory.state, operation);
}

function secureEnvFiles() {
  return withEnvDirectory(directory => withEnvSnapshots(directory, 'secureEnvFiles', (live, backup) => {
    return { livePresent: Boolean(live), backupPresent: Boolean(backup) };
  }), 'secureEnvFiles');
}

function readEnvFileForMutation(required = false) {
  return withEnvDirectory(directory => withEnvSnapshots(directory, 'readEnvFileForMutation', live => {
    if (!live) return null;
    const bytes = Buffer.from(live.bytes);
    return { bytes, text: decodeEnvUtf8(bytes) };
  }, required), 'readEnvFileForMutation');
}

function writeEnvFile(vars) {
  return withEnvDirectory(directory => withEnvSnapshots(directory, 'writeEnvFile', live => {
    const bytes = live ? Buffer.from(live.bytes) : Buffer.alloc(0);
    const prior = decodeEnvUtf8(bytes);
    let text;
    if (!prior) {
      text = Object.entries(vars).map(([key, value]) => key + '=' + value).join('\n') + '\n';
    } else {
      text = prior;
      for (const [key, value] of Object.entries(vars)) text = setEnvLine(text, key, value);
    }
    publishEnvContent(directory, directory.name, text, live, live ? 'replace' : 'create-only');
    console.log('\n  ✓ Env file written: ' + CFG.envFile);
  }), 'writeEnvFile');
}

function writeEnvFileAtomic(text, expectedBytes) {
  if (!Buffer.isBuffer(expectedBytes)) {
    throw new CredentialEnvError({ operation: 'writeEnvFileAtomic', phase: 'validate', reason: 'CONTENT_TYPE_INVALID' });
  }
  return withEnvDirectory(directory => withEnvSnapshots(directory, 'writeEnvFileAtomic', live => {
    if (!live || !live.bytes.equals(expectedBytes)) {
      throw new CredentialEnvError({ operation: 'writeEnvFileAtomic', phase: 'verify', reason: 'SNAPSHOT_CHANGED', published: directory.state.published, publication: directory.state.publication });
    }
    decodeEnvUtf8(live.bytes);
    publishEnvContent(directory, directory.name, text, live, 'replace');
  }), 'writeEnvFileAtomic');
}

function backupEnvFile() {
  return withEnvDirectory(directory => withEnvSnapshots(directory, 'backupEnvFile', (live, backup) => {
    if (!live) throw new CredentialEnvError({ operation: 'backupEnvFile', phase: 'validate', reason: 'REQUIRED_FILE_MISSING', published: directory.state.published, publication: directory.state.publication });
    if (backup) return { retained: true };
    publishEnvContent(directory, directory.name + '.pre-gen2', Buffer.from(live.bytes), null, 'create-only');
    return { retained: false };
  }), 'backupEnvFile');
}




function toUciCloudKey(envKey) {
  const mapping = {
    CHIRPSTACK_APP_SENSORS: 'chirpstack_app_sensors',
    CHIRPSTACK_APP_ACTUATORS: 'chirpstack_app_actuators',
    CHIRPSTACK_APP_FIELD_TESTER: 'chirpstack_app_field_tester',
    CHIRPSTACK_PROFILE_KIWI: 'chirpstack_profile_kiwi',
    CHIRPSTACK_PROFILE_STREGA: 'chirpstack_profile_strega',
    CHIRPSTACK_PROFILE_STREGA_GEN2: 'chirpstack_profile_strega_gen2',
    CHIRPSTACK_PROFILE_LSN50: 'chirpstack_profile_lsn50',
    CHIRPSTACK_PROFILE_CLOVER: 'chirpstack_profile_clover',
    CHIRPSTACK_PROFILE_RAK10701: 'chirpstack_profile_rak10701',
    CHIRPSTACK_PROFILE_S2120: 'chirpstack_profile_s2120',
    CHIRPSTACK_PROFILE_LORAIN: 'chirpstack_profile_lorain',
    CHIRPSTACK_PROFILE_UC512: 'chirpstack_profile_uc512',
    CHIRPSTACK_PROFILE_SDI12: 'chirpstack_profile_sdi12'
  };
  return mapping[envKey] || null;
}

function assertValidUciValue(envKey, value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (envKey.startsWith('CHIRPSTACK_APP_') || envKey.startsWith('CHIRPSTACK_PROFILE_')) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
      throw new Error(`${envKey} is not a valid ChirpStack UUID: ${text}`);
    }
  }
  return true;
}

function writeUciConfig(envVars) {
  const commands = [];
  for (const [envKey, value] of Object.entries(envVars)) {
    const uciKey = toUciCloudKey(envKey);
    if (!uciKey || !assertValidUciValue(envKey, value)) continue;
    commands.push(['set', `osi-server.cloud.${uciKey}=${String(value).trim()}`]);
  }
  if (!commands.length) return;
  try {
    for (const args of commands) {
      execFileSync('uci', args, { stdio: 'inherit' });
    }
    execFileSync('uci', ['commit', 'osi-server'], { stdio: 'inherit' });
    for (const [envKey, value] of Object.entries(envVars)) {
      const uciKey = toUciCloudKey(envKey);
      if (!uciKey || !String(value || '').trim()) continue;
      const actual = execFileSync('uci', ['-q', 'get', `osi-server.cloud.${uciKey}`], { encoding: 'utf8' }).trim();
      if (actual !== String(value).trim()) {
        throw new Error(`UCI readback mismatch for ${uciKey}`);
      }
    }
    console.log('  ✓ UCI ChirpStack config committed: osi-server.cloud');
  } catch (error) {
    throw new Error(`Unable to persist ChirpStack UCI config: ${error.message}`);
  }
}

function patchSettingsJs() {
  if (!fs.existsSync(CFG.settingsJs)) {
    console.log(`  ⚠ settings.js not found at ${CFG.settingsJs} — skipping patch`);
    return;
  }
  let src = fs.readFileSync(CFG.settingsJs, 'utf8');
  if (src.includes(ENV_LOADER_MARKER)) {
    console.log('  ✓ settings.js already patched');
    return;
  }
  const loader = `
${ENV_LOADER_MARKER}
try {
  const protectedKeys = new Set([
    'DEVICE_EUI',
    'DEVICE_EUI_SOURCE',
    'DEVICE_EUI_CONFIDENCE',
    'DEVICE_EUI_LAST_VERIFIED_AT',
    'LINK_GATEWAY_DEVICE_EUI'
  ]);
  require('fs').readFileSync(${JSON.stringify(CFG.envFile)}, 'utf8')
    .split('\\n').filter(l => l.includes('=')).forEach(l => {
      const eq = l.indexOf('=');
      if (eq <= 0) return;
      const key = l.slice(0, eq).trim();
      if (!key) return;
      if (protectedKeys.has(key) && String(process.env[key] || '').trim()) return;
      process.env[key] = l.slice(eq + 1).trim();
    });
} catch (e) {}
// [/OSI]
`;
  if (src.includes("'use strict'") || src.includes('"use strict"')) {
    src = src.replace(/(['"])use strict\1;?\s*\n/, (match) => match + loader);
  } else {
    src = loader + src;
  }
  fs.writeFileSync(CFG.settingsJs, src, 'utf8');
  console.log('  ✓ settings.js patched to load env file on startup');
}

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
    console.log([
      '  ⚠ flows.json uses the legacy mutation pattern and is not portable.',
      ...badTopics.map((entry) => `bad mqtt topic: ${entry}`),
      ...hardcodedDownlinks.map((entry) => `hardcoded downlink app id: ${entry}`),
      '  ⚠ Bootstrap will not repair or mutate flows.json. Deploy the portable repo flow before relying on runtime env configuration.'
    ].join('\n'));
    if (process.env.OSI_BOOTSTRAP_REQUIRE_PORTABLE_FLOW === '1') {
      throw new Error('flows.json is not portable');
    }
    return;
  }
  console.log('  ✓ flows.json portable communication contract verified');
}

const KIWI_ENV_KEY = 'CHIRPSTACK_PROFILE_KIWI';
const CLOVER_ENV_KEY = 'CHIRPSTACK_PROFILE_CLOVER';
const RAK10701_ENV_KEY = 'CHIRPSTACK_PROFILE_RAK10701';
const REPAIR_FLAG = '--repair-soil-profiles';
const REPOINT_FLAG = '--repoint-clover-device';

function readTektelicCodecScript() {
  return readCodecScript(CFG.tektelicCodecPath, 'Tektelic KIWI/CLOVER');
}

// A profile that already runs a JS codec keeps it (keepExistingCodec), so a
// codec attached by hand is never replaced; a profile without one gets the
// shipped Tektelic codec.
async function getOrCreateKiwiProfile(client, tenantId, codecScript) {
  return getOrCreateProfileWithCodec(client, tenantId, CFG.profileKiwiName, KIWI_PROFILE_DESCRIPTION, codecScript, {
    keepExistingCodec: true
  });
}

async function getOrCreateCloverProfile(client, tenantId, codecScript) {
  return getOrCreateProfileWithCodec(client, tenantId, CFG.profileCloverName, CLOVER_PROFILE_DESCRIPTION, codecScript, {
    keepExistingCodec: true
  });
}

function assertCloverProfileDistinct(cloverProfileId, rak10701ProfileId) {
  if (String(cloverProfileId || '').trim() && String(cloverProfileId).trim() === String(rak10701ProfileId || '').trim()) {
    throw new Error('The Clover and the RAK field-tester profile resolve to the same ChirpStack profile; check CS_PROFILE_CLOVER_NAME and CS_PROFILE_RAK_NAME');
  }
}

// --- Repair mode (--repair-soil-profiles) ----------------------------------
// Never falls through to the full provisioning pass: it creates no tenant,
// application or API key, and never rewrites the env file wholesale.


// First occurrence wins, as in node-red.init's load_chirpstack_env_value.
function parseEnvText(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key && !Object.prototype.hasOwnProperty.call(values, key)) {
      values[key] = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return values;
}

// Rewrites every line of one key and keeps every other line as it is.
function setEnvLine(text, key, value) {
  const lines = String(text).split('\n');
  let found = false;
  const out = lines.map((line) => {
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (out.length > 1 && out[out.length - 1] === '') out.splice(out.length - 1, 0, `${key}=${value}`);
    else out.push(`${key}=${value}`);
  }
  return out.join('\n');
}

// The env file holds the API key: write a temp file, flush it to disk, then
// rename it over the old one, so a power cut leaves either file, never an
// empty one.

function readUciValue(envKey) {
  const uciKey = toUciCloudKey(envKey);
  if (!uciKey) return '';
  try {
    return String(execFileSync('uci', ['-q', 'get', `osi-server.cloud.${uciKey}`], { encoding: 'utf8' }) || '').trim();
  } catch (_) {
    return '';
  }
}

function parseRepairArgs(argv) {
  const options = { repair: false, repointDevEuis: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === REPAIR_FLAG) {
      options.repair = true;
    } else if (arg === REPOINT_FLAG || arg.startsWith(REPOINT_FLAG + '=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[(i += 1)];
      const parts = String(value === undefined ? '' : value).split(',').map((part) => part.trim()).filter(Boolean);
      if (!parts.length || parts.some((part) => part.startsWith('--'))) throw new UsageError();
      options.repointDevEuis.push(...parts);
      options.repair = true;
    } else {
      throw new UsageError();
    }
  }
  return options;
}

function profileGetter(profile, getter) {
  return profile && typeof profile[getter] === 'function' ? profile[getter]() : undefined;
}

function hasJsCodec(profile) {
  return Number(profileGetter(profile, 'getPayloadCodecRuntime')) === 2
    && Boolean(normalizeCodecScript(profileGetter(profile, 'getPayloadCodecScript')));
}

// Leaves a profile alone when it already runs a JS codec (also one attached by
// hand); otherwise attaches the shipped codec, keeping the profile's own name,
// description and intervals. Returns 'kept', 'attached' or 'missing'.
async function ensureProfileCodec(client, profileId, label, codecScript) {
  const profile = await client.getDeviceProfile(profileId);
  if (!profile) return 'missing';
  if (hasJsCodec(profile)) {
    console.log(`  ✓ ${label} profile ${profileId} keeps its codec`);
    return 'kept';
  }
  await client.updateDeviceProfile({
    id: profileId,
    tenantId: profileGetter(profile, 'getTenantId'),
    name: profileGetter(profile, 'getName'),
    description: profileGetter(profile, 'getDescription'),
    region: CFG.region,
    uplinkInterval: profileGetter(profile, 'getUplinkInterval') || 3600,
    deviceStatusReqInterval: profileGetter(profile, 'getDeviceStatusReqInterval') || 1,
    autoDetectMeasurements: true,
    payloadCodecScript: normalizeCodecScript(codecScript)
  });
  console.log(`  ~ ${label} profile ${profileId}: Tektelic codec attached`);
  return 'attached';
}

async function findTenantId(client) {
  const tenants = listItemsToObjects(await client.listTenants());
  const tenant = tenants.find((candidate) => candidate.name === CFG.tenantName) || tenants[0];
  if (!tenant) {
    throw new Error('no ChirpStack tenant: this gateway is not provisioned; let the osi-bootstrap service provision it');
  }
  return tenant.id;
}

async function repairKiwiProfile(client, envValues, codecScript) {
  const kiwiProfileId = readUciValue(KIWI_ENV_KEY) || String(envValues[KIWI_ENV_KEY] || '').trim();
  if (!kiwiProfileId) {
    console.log('  ⚠ no Kiwi profile id configured; nothing to repair');
    return;
  }
  if ((await ensureProfileCodec(client, kiwiProfileId, 'Kiwi', codecScript)) === 'missing') {
    console.log(`  ⚠ Kiwi profile ${kiwiProfileId} not found in ChirpStack; left as it is`);
  }
}

async function repairCloverProfile(client, envText, envValues, codecScript, expectedBytes) {
  const rak10701ProfileId = readUciValue(RAK10701_ENV_KEY) || String(envValues[RAK10701_ENV_KEY] || '').trim();
  const uciClover = readUciValue(CLOVER_ENV_KEY);
  const envClover = String(envValues[CLOVER_ENV_KEY] || '').trim();
  const usable = (value) => Boolean(value) && !(rak10701ProfileId && value === rak10701ProfileId);
  // node-red.init resolves UCI first; a distinct id in either store is a
  // deliberate choice and is kept, also when the other store holds the alias.
  let cloverProfileId = usable(uciClover) ? uciClover : (usable(envClover) ? envClover : '');
  // A distinct id alone is not proof: the profile must exist and run a codec.
  if (cloverProfileId && (await ensureProfileCodec(client, cloverProfileId, 'Clover', codecScript)) === 'missing') {
    console.log(`  ⚠ configured Clover profile ${cloverProfileId} not found in ChirpStack; using "${CFG.profileCloverName}"`);
    cloverProfileId = '';
  }
  if (!cloverProfileId) {
    cloverProfileId = await getOrCreateCloverProfile(client, await findTenantId(client), codecScript);
  }
  assertCloverProfileDistinct(cloverProfileId, rak10701ProfileId);

  let changed = false;
  if (uciClover !== cloverProfileId) {
    writeUciConfig({ [CLOVER_ENV_KEY]: cloverProfileId });
    changed = true;
  }
  if (envClover !== cloverProfileId) {
    writeEnvFileAtomic(setEnvLine(envText, CLOVER_ENV_KEY, cloverProfileId), expectedBytes);
    console.log(`  ✓ ${CFG.envFile}: ${CLOVER_ENV_KEY}=${cloverProfileId}`);
    changed = true;
  }
  if (changed) {
    console.log('  Restart Node-RED for the new Clover profile id to take effect (deploy.sh does this).');
    console.log(`  A Clover registered before this repair stays on the field-tester profile until it is`);
    console.log(`  re-registered, or moved with: ${REPOINT_FLAG}=<DevEUI>`);
  } else {
    console.log(`  ✓ Clover profile ${cloverProfileId} is distinct from the field-tester profile`);
  }
  return { cloverProfileId, rak10701ProfileId };
}

async function repointCloverDevices(client, devEuis, cloverProfileId, rak10701ProfileId) {
  const problems = [];
  for (const raw of devEuis) {
    const devEui = chirpstack.normalizeDevEui(raw);
    if (!/^[0-9A-F]{16}$/.test(devEui)) {
      problems.push(`${raw}: not a 16-hex DevEUI`);
      continue;
    }
    const device = await client.getDevice(devEui);
    if (!device) {
      problems.push(`${devEui}: not registered in ChirpStack`);
      continue;
    }
    const current = String(device.getDeviceProfileId() || '').trim();
    if (current === cloverProfileId) {
      console.log(`  ✓ ${devEui} already on the Clover profile`);
    } else if (rak10701ProfileId && current === rak10701ProfileId) {
      await client.setDeviceProfile(devEui, cloverProfileId);
      console.log(`  ~ ${devEui} moved from the field-tester profile to the Clover profile`);
    } else {
      problems.push(`${devEui}: on profile ${current || '(none)'}, not the field-tester profile; left alone`);
    }
  }
  for (const problem of problems) console.log(`  ⚠ ${problem}`);
  if (problems.length) {
    throw new Error(`${problems.length} device(s) not repointed`);
  }
}

async function repairSoilProfiles(options, envInput) {
  console.log('\n[ repair ] KIWI and CLOVER device profiles');
  const envText = envInput ? envInput.text : null;
  if (envText === null) throw new CredentialEnvError({ operation: 'repairSoilProfiles', phase: 'validate', reason: 'REQUIRED_FILE_MISSING' });
  const envValues = parseEnvText(envText);
  const apiKey = String(process.env.CHIRPSTACK_API_KEY || envValues.CHIRPSTACK_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('no ChirpStack API key in the environment or the env file; repair mode never creates one');
  }
  const codecScript = readTektelicCodecScript();
  if (!normalizeCodecScript(codecScript)) {
    throw new Error(`Tektelic codec missing at ${CFG.tektelicCodecPath}; nothing repaired`);
  }
  const apiUrl = String(process.env.CHIRPSTACK_API_URL || process.env.CS_URL || envValues.CHIRPSTACK_API_URL || CFG.url).trim();
  const client = chirpstack.createClient({ apiUrl, apiKey });

  await repairKiwiProfile(client, envValues, codecScript);
  const { cloverProfileId, rak10701ProfileId } = await repairCloverProfile(client, envText, envValues, codecScript, envInput.bytes);

  if (options.repointDevEuis.length) {
    console.log('\n[ repair ] Registered Clover devices');
    await repointCloverDevices(client, options.repointDevEuis, cloverProfileId, rak10701ProfileId);
  }
  console.log('\n  Soil sensor profile repair complete\n');
}

async function main(envInput) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   OSI OS  —  ChirpStack Bootstrap            ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`  ChirpStack gRPC URL : ${CFG.url}`);
  console.log(`  LoRaWAN region      : ${CFG.region}`);
  console.log(`  API key mode        : ${CFG.apiKey ? 'pre-created' : 'CLI create-api-key'}`);
  console.log(`  Env file            : ${CFG.envFile}\n`);

  console.log('[ 1/5 ] API key');
  let apiKey = CFG.apiKey;
  if (!apiKey) {
    apiKey = await createApiKeyViaCLI();
  } else {
    console.log('  ✓ Using pre-created API key');
  }

  const client = chirpstack.createClient({ apiUrl: CFG.url, apiKey });

  console.log('\n[ 2/5 ] Tenant');
  const tenantId = await getOrCreateTenant(client);

  console.log('\n[ 3/5 ] Applications');
  const sensorsAppId = await getOrCreateApp(client, tenantId, CFG.appSensorsName, 'KIWI soil sensors and Dragino LSN50 dendrometers');
  const actuatorsAppId = await getOrCreateApp(client, tenantId, CFG.appActuatorsName, 'STREGA smart irrigation valves');
  const fieldTesterAppId = await getOrCreateApp(client, tenantId, CFG.appFieldTesterName, 'RAK10701 field coverage testing');

  console.log('\n[ 4/5 ] Device profiles');
  const tektelicCodecScript = readTektelicCodecScript();
  const kiwiProfileId = await getOrCreateKiwiProfile(client, tenantId, tektelicCodecScript);
  const cloverProfileId = await getOrCreateCloverProfile(client, tenantId, tektelicCodecScript);
  const stregaCodecScript = readCodecScript(CFG.stregaCodecPath, 'STREGA');
  const stregaProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileStregaName, 'Strega smart irrigation valve (LoRaWAN 1.0.3 OTAA)', stregaCodecScript);
  const stregaGen2CodecScript = readCodecScript(CFG.stregaGen2CodecPath, 'STREGA Gen2');
  const stregaGen2ProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileStregaGen2Name, 'Strega SV2 smart irrigation valve, Gen2 scheduler (LoRaWAN 1.0.3 OTAA)', stregaGen2CodecScript);
  const lsn50CodecScript = readCodecScript(CFG.lsn50CodecPath, 'LSN50');
  const lsn50ProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileLsn50Name, 'Dragino LSN50 temperature & dendrometer ADC (LoRaWAN 1.0.3 OTAA)', lsn50CodecScript);
  const rak10701ProfileId = await getOrCreateProfile(client, tenantId, CFG.profileRakName, 'RAK10701 LoRaWAN coverage field tester');
  const s2120CodecScript = readCodecScript(CFG.s2120CodecPath, 'S2120');
  const s2120ProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileS2120Name, 'SenseCAP S2120 8-in-1 weather station (LoRaWAN 1.0.3 OTAA)', s2120CodecScript);
  const lorainCodecScript = readCodecScript(CFG.lorainCodecPath, 'LoRain');
  const lorainProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileLorainName, 'Aqua-Scope LoRain RANLWE01 rain gauge (LoRaWAN 1.0.3 OTAA)', lorainCodecScript);
  const uc512CodecScript = readCodecScript(CFG.uc512CodecPath, 'UC512');
  const uc512ProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileUc512Name, 'Milesight UC512 dual-valve controller (LoRaWAN 1.0.3 OTAA)', uc512CodecScript);
  const sdi12Script = readCodecScript(CFG.sdi12CodecPath, 'SDI12');
  const sdi12ProfileId = await getOrCreateProfileWithCodec(client, tenantId, CFG.profileSdi12Name, 'Dragino SDI-12-LB/LS soil probe converter (LoRaWAN 1.0.3 OTAA)', sdi12Script);
  assertCloverProfileDistinct(cloverProfileId, rak10701ProfileId);

  console.log('\n[ 5/5 ] Writing configuration');
  const gatewayEui = detectGatewayEui();
  if (gatewayEui) {
    console.log(`  ✓ Gateway EUI detected: ${gatewayEui}`);
  } else {
    console.log('  ⚠ Gateway EUI not detected — set DEVICE_EUI manually in .chirpstack.env');
  }
  const envVars = {
    CHIRPSTACK_API_URL: CFG.url,
    CHIRPSTACK_API_KEY: apiKey,
    CHIRPSTACK_APP_SENSORS: sensorsAppId,
    CHIRPSTACK_APP_ACTUATORS: actuatorsAppId,
    CHIRPSTACK_APP_FIELD_TESTER: fieldTesterAppId,
    CHIRPSTACK_PROFILE_KIWI: kiwiProfileId,
    CHIRPSTACK_PROFILE_STREGA: stregaProfileId,
    CHIRPSTACK_PROFILE_STREGA_GEN2: stregaGen2ProfileId,
    CHIRPSTACK_PROFILE_LSN50: lsn50ProfileId,
    CHIRPSTACK_PROFILE_CLOVER: cloverProfileId,
    CHIRPSTACK_PROFILE_RAK10701: rak10701ProfileId,
    CHIRPSTACK_PROFILE_S2120: s2120ProfileId,
    CHIRPSTACK_PROFILE_LORAIN: lorainProfileId,
    CHIRPSTACK_PROFILE_UC512: uc512ProfileId,
    CHIRPSTACK_PROFILE_SDI12: sdi12ProfileId
  };
  writeEnvFile(envVars);
  writeUciConfig(envVars);

  if (process.env.OSI_BOOTSTRAP_PATCH_SETTINGS === '1') {
    patchSettingsJs();
  }
  validatePortableFlows();

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Bootstrap complete                         ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('  Applications found / created:');
  console.log(`    ${CFG.appSensorsName.padEnd(20)} ${sensorsAppId}`);
  console.log(`    ${CFG.appActuatorsName.padEnd(20)} ${actuatorsAppId}`);
  console.log(`    ${CFG.appFieldTesterName.padEnd(20)} ${fieldTesterAppId}\n`);
  console.log('  Device profiles:');
  console.log(`    ${CFG.profileKiwiName.padEnd(24)} ${kiwiProfileId}`);
  console.log(`    ${CFG.profileCloverName.padEnd(24)} ${cloverProfileId}`);
  console.log(`    ${CFG.profileStregaName.padEnd(24)} ${stregaProfileId}`);
  console.log(`    ${CFG.profileStregaGen2Name.padEnd(24)} ${stregaGen2ProfileId}`);
  console.log(`    ${CFG.profileLsn50Name.padEnd(24)} ${lsn50ProfileId}`);
  console.log(`    ${CFG.profileRakName.padEnd(24)} ${rak10701ProfileId}`);
  console.log(`    ${CFG.profileS2120Name.padEnd(24)} ${s2120ProfileId}`);
  console.log(`    ${CFG.profileLorainName.padEnd(24)} ${lorainProfileId}`);
  console.log(`    ${CFG.profileUc512Name.padEnd(24)} ${uc512ProfileId}\n`);
  console.log(`    ${CFG.profileSdi12Name.padEnd(24)} ${sdi12ProfileId}\n`);
  if (gatewayEui) {
    console.log(`  Gateway EUI (DEVICE_EUI): ${gatewayEui}\n`);
  } else {
    console.log('  ⚠ Gateway EUI: NOT DETECTED — add DEVICE_EUI=<eui> to .chirpstack.env manually\n');
  }
  console.log('  Next step:');
  console.log('  1. Restart Node-RED:  /etc/init.d/node-red restart');
  console.log('  2. Register devices via the OSI OS UI or OSI Server UI (type + DevEUI + AppKey from device label)\n');
}

async function run(argv) {
  const fileOnly = argv.filter((arg) => {
    const value = String(arg);
    return value === '--secure-env-file' || value === '--backup-env-file'
      || value.startsWith('--secure-env-file=') || value.startsWith('--backup-env-file=');
  });
  if (fileOnly.length) {
    if (argv.length !== 1 || fileOnly.length !== 1
      || (argv[0] !== '--secure-env-file' && argv[0] !== '--backup-env-file')) {
      throw new UsageError();
    }
    if (argv[0] === '--secure-env-file') {
      secureEnvFiles();
      return;
    }
    backupEnvFile();
    return;
  }
  const options = parseRepairArgs(argv);
  secureEnvFiles();
  const envInput = readEnvFileForMutation(Boolean(options.repair));
  chirpstack = loadChirpStackHelper();
  if (options.repair) {
    await repairSoilProfiles(options, envInput);
    return;
  }
  await main(envInput);
}

function safeCredentialDiagnostic(error) {
  return 'Credential env-file operation failed ' + JSON.stringify({
    operation: error.operation,
    phase: error.phase,
    reason: error.reason,
    osCode: error.osCode,
    published: Boolean(error.published),
    publication: error.publication,
    cleanupErrors: error.cleanupErrors
  });
}

run(process.argv.slice(2)).catch((error) => {
  if (error instanceof CredentialEnvError) {
    console.error(safeCredentialDiagnostic(error));
    process.exit(74);
    return;
  }
  if (error instanceof UsageError) {
    console.error('Invalid ChirpStack bootstrap arguments. Usage: chirpstack-bootstrap.js [--repair-soil-profiles] [--repoint-clover-device=<DevEUI>] [--secure-env-file|--backup-env-file]');
    process.exit(2);
    return;
  }
  console.error('\nBootstrap failed:', error.message);
  process.exit(1);
});
