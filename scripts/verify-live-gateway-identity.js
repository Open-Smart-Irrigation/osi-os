#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const profiles = [
  'conf/full_raspberrypi_bcm27xx_bcm2712',
  'conf/full_raspberrypi_bcm27xx_bcm2709',
];
const failures = [];

function fail(message) {
  failures.push(message);
}

function ok(message) {
  console.log(`OK ${message}`);
}

function read(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`missing required file: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function expectIncludes(label, source, needle, description) {
  if (source.includes(needle)) ok(`${label}: ${description}`);
  else fail(`${label}: ${description}; missing ${JSON.stringify(needle)}`);
}

function expectExcludes(label, source, needle, description) {
  if (!source.includes(needle)) ok(`${label}: ${description}`);
  else fail(`${label}: ${description}; found ${JSON.stringify(needle)}`);
}

function expectCondition(condition, passMessage, failureMessage) {
  if (condition) ok(passMessage);
  else fail(failureMessage);
}

function expectMode(relativePath, expectedMode) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  const actualMode = fs.statSync(absolutePath).mode & 0o777;
  expectCondition(
    actualMode === expectedMode,
    `${relativePath}: mode ${expectedMode.toString(8)}`,
    `${relativePath}: expected mode ${expectedMode.toString(8)}, got ${actualMode.toString(8)}`
  );
}

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

function sha256(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function shellIntegerAssignment(source, name) {
  const match = source.match(new RegExp(`^${name}=([0-9]+)$`, 'm'));
  return match ? Number(match[1]) : null;
}

const paritySource = read('scripts/verify-profile-parity.js');
const syncVerifierSource = read('scripts/verify-sync-flow.js');
const deploySource = read('deploy.sh');
const openWrtConfig = read('openwrt/osi-os.config');
const jsonfilterMakefile = read('openwrt/package/utils/jsonfilter/Makefile');
const procdMakefile = read('openwrt/package/system/procd/Makefile');
const bootInitSource = read('openwrt/package/base-files/files/etc/init.d/boot');
const nodeRedInitSource = read('feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init');
const lifecycleTestPath = 'scripts/test-identityd-service-lifecycle.sh';
const lifecycleTestSource = read(lifecycleTestPath);
const silentCatchBaselineSource = read('scripts/fixtures/silent-catch-baseline.json');
const sizeAllowancesSource = read('scripts/verify-flows-size-ratchet-allowances.json');

expectIncludes('openwrt/osi-os.config', openWrtConfig, 'CONFIG_PACKAGE_jsonfilter=y', 'build includes jsonfilter');
expectIncludes('jsonfilter Makefile', jsonfilterMakefile, 'PKG_NAME:=jsonfilter', 'pinned OpenWrt source declares jsonfilter');
expectIncludes('jsonfilter Makefile', jsonfilterMakefile, 'PKG_SOURCE_VERSION:=594cfa86469c005972ba750614f5b3f1af84d0f6', 'pins the reviewed jsonfilter source revision');
expectIncludes('jsonfilter Makefile', jsonfilterMakefile, '$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/bin/jsonpath $(1)/usr/bin/jsonfilter', 'package installs /usr/bin/jsonfilter');
expectIncludes('procd Makefile', procdMakefile, 'PKG_SOURCE_VERSION:=42d3937654508b04da64969f9d764ac2ec411904', 'pins the reviewed procd rcS snapshot semantics');
expectIncludes('OpenWrt boot init', bootInitSource, 'mkdir -p /var/run', 'creates the daemon run directory before applying uci-defaults');
expectIncludes('OpenWrt boot init', bootInitSource, '( . "./$(basename $file)" ) && rm -f "$file"', 'retains a failed uci-default for the next boot');
expectIncludes('scripts/verify-sync-flow.js', syncVerifierSource, "[path.resolve(__dirname, 'verify-live-gateway-identity.js')]", 'sync verification chains the live identity verifier');
expectMode(lifecycleTestPath, 0o755);
const nodeRedStop = shellIntegerAssignment(nodeRedInitSource, 'STOP');
expectCondition(nodeRedStop !== null,
  `Node-RED init: STOP=${nodeRedStop}`,
  'Node-RED init: numeric STOP assignment is missing');

let canonicalDaemon = '';
let canonicalBootstrap = '';
let canonicalService = '';
let canonicalEnable = '';
for (const profile of profiles) {
  const profileConfigPath = `${profile}/.config`;
  const daemonPath = `${profile}/files/usr/libexec/osi-identityd.sh`;
  const servicePath = `${profile}/files/etc/init.d/osi-identityd`;
  const enablePath = `${profile}/files/etc/uci-defaults/94_osi_identityd_enable`;
  const bootstrapPath = `${profile}/files/etc/init.d/osi-bootstrap`;

  const profileConfig = read(profileConfigPath);
  const daemon = read(daemonPath);
  const service = read(servicePath);
  const enable = read(enablePath);
  const bootstrap = read(bootstrapPath);

  expectIncludes(profileConfigPath, profileConfig, 'CONFIG_PACKAGE_jsonfilter=y', 'profile image includes jsonfilter');
  expectMode(daemonPath, 0o755);
  expectMode(servicePath, 0o755);
  expectMode(enablePath, 0o755);
  expectMode(bootstrapPath, 0o755);

  expectIncludes(servicePath, service, 'START=98', 'service starts before Node-RED and bootstrap');
  expectIncludes(servicePath, service, 'STOP=98', 'service stops before Node-RED STOP=99');
  const identitydStop = shellIntegerAssignment(service, 'STOP');
  expectCondition(identitydStop !== null && nodeRedStop !== null && identitydStop < nodeRedStop,
    `${servicePath}: STOP=${identitydStop} precedes Node-RED STOP=${nodeRedStop}`,
    `${servicePath}: numeric STOP must precede the actual Node-RED STOP=${nodeRedStop}`);
  expectIncludes(servicePath, service, 'USE_PROCD=1', 'service uses procd');
  expectIncludes(servicePath, service, 'procd_set_param command /usr/libexec/osi-identityd.sh start', 'service launches the identity daemon');
  expectIncludes(servicePath, service, 'procd_set_param respawn', 'service is supervised with respawn');
  expectIncludes(servicePath, service, 'EXTRA_COMMANDS="ready"', 'service exposes one readiness contract');
  expectIncludes(servicePath, service, 'service_running || return 1\n\t/usr/libexec/osi-identityd.sh ready', 'ready requires procd running and the daemon-owned live lock');
  expectIncludes(enablePath, enable, 'identityd_queued=0', 'defaults to a same-boot start');
  expectIncludes(enablePath, enable, '[ -e /etc/rc.d/S98osi-identityd ] && identityd_queued=1', 'records whether rcS already queued the service before enabling it');
  expectIncludes(enablePath, enable, '/etc/init.d/osi-identityd enable || exit 1', 'uci-defaults enables the service and remains retryable on failure');
  expectIncludes(enablePath, enable,
    'if [ "$identityd_queued" -eq 0 ]; then\n    /etc/init.d/osi-identityd start\n    identityd_ready_attempts=0\n    while ! /etc/init.d/osi-identityd ready; do\n        identityd_ready_attempts=$((identityd_ready_attempts + 1))\n        [ "$identityd_ready_attempts" -lt 5 ] || exit 1\n        sleep 1\n    done\nfi',
    'starts the service on the same factory boot and verifies a fresh live lock owner with a bounded retry');
  const queuedCheckAt = enable.indexOf('[ -e /etc/rc.d/S98osi-identityd ] && identityd_queued=1');
  const enableCallAt = enable.indexOf('/etc/init.d/osi-identityd enable || exit 1');
  const sameBootStartAt = enable.indexOf('/etc/init.d/osi-identityd start');
  const readyPostconditionAt = enable.indexOf('while ! /etc/init.d/osi-identityd ready; do');
  expectCondition(queuedCheckAt >= 0 && enableCallAt > queuedCheckAt && sameBootStartAt > enableCallAt && readyPostconditionAt > sameBootStartAt,
    `${enablePath}: checks the rcS snapshot, enables, starts conditionally, then verifies readiness`,
    `${enablePath}: rcS snapshot, enable, conditional start, and ready postcondition must remain ordered`);
  expectCondition(countMatches(enable, /\/etc\/init\.d\/osi-identityd enable/g) === 1 && countMatches(enable, /\/etc\/init\.d\/osi-identityd start/g) === 1,
    `${enablePath}: has exactly one enable and one conditional start call`,
    `${enablePath}: expected exactly one enable and one conditional start call`);
  expectCondition(countMatches(enable, /\/etc\/init\.d\/osi-identityd ready/g) === 1,
    `${enablePath}: has exactly one post-start readiness check`,
    `${enablePath}: expected exactly one post-start readiness check`);

  expectIncludes(bootstrapPath, bootstrap, '/usr/libexec/osi-identityd.sh request-restart chirpstack_bootstrap 60', 'bootstrap requests a coordinated restart');
  expectIncludes(bootstrapPath, bootstrap,
    'if ! /etc/init.d/osi-identityd ready; then\n\t\t\trm -f /etc/osi-bootstrap.done\n\t\t\tlogger -t osi-bootstrap "identityd is not ready; bootstrap will retry"\n\t\t\treturn 0\n\t\tfi\n\t\tif /usr/libexec/osi-identityd.sh request-restart chirpstack_bootstrap 60; then',
    'bootstrap proves a live consumer immediately before publishing its restart request');
  expectIncludes(bootstrapPath, bootstrap, 'rm -f /etc/osi-bootstrap.done', 'bootstrap removes its stamp when restart coordination fails');
  expectIncludes(bootstrapPath, bootstrap, 'bootstrap will retry', 'bootstrap logs restart-request retry behavior');
  expectExcludes(bootstrapPath, bootstrap, '/etc/init.d/node-red restart', 'bootstrap does not restart Node-RED directly');

  expectIncludes(daemonPath, daemon, 'jsonfilter -i "$1" -e "@.$2"', 'daemon parses JSON with jsonfilter');
  expectIncludes(daemonPath, daemon, 'identityd_ready()', 'daemon owns the lock-readiness predicate');
  expectIncludes(daemonPath, daemon,
    'identityd_ready() {\n    local owner\n    identityd_refresh_paths\n    [ -L "$IDENTITYD_LOCK_DIR" ] || return 1\n    owner="$(readlink "$IDENTITYD_LOCK_DIR" 2>/dev/null)" || return 1\n    identityd_uint_valid "$owner" "$IDENTITYD_MAX_EPOCH" || return 1\n    [ "$owner" -gt 1 ] || return 1\n    kill -0 "$owner" 2>/dev/null\n}',
    'readiness requires the atomic symlink lock and its canonical live PID owner');
  expectIncludes(daemonPath, daemon, 'ready)\n            [ "$#" -eq 1 ] || return 2\n            identityd_ready', 'daemon CLI exposes readiness');
  expectIncludes(daemonPath, daemon, 'jsonfilter -i "$1" -t "@.$2"', 'daemon validates nullable JSON field types with jsonfilter');
  expectIncludes(daemonPath, daemon, 'IDENTITYD_MAX_EPOCH=2147483647', 'daemon bounds shell arithmetic inputs');
  expectIncludes(daemonPath, daemon, 'IFS=\'. \' read -r seconds remainder < /proc/uptime', 'daemon reads a monotonic clock');
  expectIncludes(daemonPath, daemon, 'restartNotBeforeUptime', 'sentinel carries a monotonic deadline');
  expectIncludes(daemonPath, daemon, 'restart_uptime=$((IDENTITYD_NOW_UPTIME + delay))', 'queued delay begins when the daemon consumes the request');
  expectIncludes(daemonPath, daemon, 'remaining=$((IDENTITYD_SENTINEL_RESTART_UPTIME - IDENTITYD_NOW_UPTIME))', 'restart countdown uses the monotonic deadline');
  expectIncludes(daemonPath, daemon, '[ "$IDENTITYD_SENTINEL_RESTART_UPTIME" -le "$IDENTITYD_NOW_UPTIME" ] || return 0', 'restart eligibility uses the monotonic clock');
  expectCondition(countMatches(daemon, /^\s*\[ "\$raw" = "\$canonical" \] \|\| return 1\s*$/gm) === 2,
    `${daemonPath}: cache and request readers each reject non-canonical JSON`,
    `${daemonPath}: expected two strict cache/request canonical-object comparisons`);
  expectCondition(countMatches(daemon, /^\s*\[ "\$raw" = "\$canonical" \] \|\| return 2\s*$/gm) === 1,
    `${daemonPath}: sentinel reader rejects non-canonical JSON`,
    `${daemonPath}: expected one strict sentinel canonical-object comparison`);

  if (profile === profiles[0]) {
    canonicalDaemon = daemon;
    canonicalBootstrap = bootstrap;
    canonicalService = service;
    canonicalEnable = enable;
  } else {
    expectCondition(daemon === canonicalDaemon, `${daemonPath}: byte-identical mirror`, `${daemonPath}: differs from bcm2712 daemon`);
    expectCondition(bootstrap === canonicalBootstrap, `${bootstrapPath}: byte-identical mirror`, `${bootstrapPath}: differs from bcm2712 bootstrap`);
    expectCondition(service === canonicalService, `${servicePath}: byte-identical mirror`, `${servicePath}: differs from bcm2712 service`);
    expectCondition(enable === canonicalEnable, `${enablePath}: byte-identical mirror`, `${enablePath}: differs from bcm2712 enable script`);
  }
}

for (const canonicalPath of [
  'files/usr/libexec/osi-identityd.sh',
  'files/etc/init.d/osi-identityd',
  'files/etc/uci-defaults/94_osi_identityd_enable',
]) {
  expectIncludes('scripts/verify-profile-parity.js', paritySource, `'${canonicalPath}'`, `CANONICAL_PAYLOAD includes ${canonicalPath}`);
}

const deployContracts = [
  ['conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh', 'fetches the identity daemon'],
  ['/usr/libexec/osi-identityd.sh', 'installs the identity daemon'],
  ['chmod 755 /usr/libexec/osi-identityd.sh', 'marks the identity daemon executable'],
  ['conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd', 'fetches the identity service'],
  ['/etc/init.d/osi-identityd', 'installs the identity service'],
  ['chmod 755 /etc/init.d/osi-identityd', 'marks the identity service executable'],
  ['conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable', 'fetches the service enable script'],
  ['/etc/uci-defaults/94_osi_identityd_enable', 'installs the service enable script'],
  ['chmod 755 /etc/uci-defaults/94_osi_identityd_enable', 'marks the service enable script executable'],
  ['conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap', 'fetches the coordinated bootstrap service'],
  ['/etc/init.d/osi-bootstrap', 'installs the coordinated bootstrap service'],
  ['chmod 755 /etc/init.d/osi-bootstrap', 'marks the bootstrap service executable'],
  ['identityd_service() {\n    /etc/init.d/osi-identityd "$@"\n}', 'uses the installed identityd service through the lifecycle fence'],
  ['identityd_service enable', 'enables identityd during live deploy'],
  ['identityd_service start', 'starts a fresh identityd during live deploy'],
  ['identityd_service ready', 'checks the shared readiness contract during live deploy'],
];
for (const [needle, description] of deployContracts) {
  expectIncludes('deploy.sh', deploySource, needle, description);
}

expectExcludes('deploy.sh', deploySource, 'identityd_service restart', 'does not restart an unquiesced identityd instance');

const identityEnabledAt = deploySource.lastIndexOf('identityd_service enable');
const identityReadyAt = deploySource.lastIndexOf('wait_for_identityd_ready');
const activationPrerequisites = [
  ['chmod 755 /usr/libexec/osi-gateway-identity.sh', 'gateway identity helper installation'],
  ['chmod 755 /usr/libexec/osi-identityd.sh', 'identity daemon installation'],
  ['swap_call stagePayload "$DEPLOY_STAMP" "$STAGED_FLOWS" >/dev/null', 'flows payload staging'],
  ['swap_call flipTo "$DEPLOY_STAMP" >/dev/null', 'flows payload activation'],
  ['tar xzf "$TMP_DIR/react_gui.tar.gz" -C /usr/lib/node-red/gui/', 'GUI extraction'],
];
for (const [needle, description] of activationPrerequisites) {
  const prerequisiteAt = deploySource.indexOf(needle);
  expectCondition(prerequisiteAt >= 0 && identityEnabledAt > prerequisiteAt,
    `deploy.sh: identityd activation follows ${description}`,
    `deploy.sh: identityd activation must follow ${description}`);
}
expectIncludes('deploy.sh', deploySource,
  'wait_for_identityd_ready() {\n    identityd_ready_attempts=0\n    while ! identityd_service ready; do\n        identityd_ready_attempts=$((identityd_ready_attempts + 1))\n        [ "$identityd_ready_attempts" -lt 5 ] || return 1\n        identityd_sleep 1\n    done\n}',
  'uses a bounded shared readiness loop');
expectIncludes('deploy.sh', deploySource,
  'identityd_lock_present() {\n    [ -e "$IDENTITYD_LOCK_PATH" ] || [ -L "$IDENTITYD_LOCK_PATH" ]\n}',
  'treats broken symlink locks as present');
expectIncludes('deploy.sh', deploySource,
  'while identityd_service running || identityd_lock_present; do',
  'waits for both procd absence and lock absence');
expectExcludes('deploy.sh', deploySource, 'rm -f "$IDENTITYD_LOCK_PATH"', 'never deletes the daemon ownership lock');
expectExcludes('deploy.sh', deploySource, 'osi-node-red-restart-requests', 'preserves queued restart requests while quiesced');
expectExcludes('deploy.sh', deploySource, 'osi-identity-restart.json', 'preserves the restart sentinel while quiesced');
expectIncludes('deploy.sh', deploySource,
  'install_deploy_exit_trap\nquiesce_identityd_for_deploy || exit 1\nrun_schema_migration || exit 1',
  'installs restoration and proves quiescence before the sole migration call');
expectCondition(countMatches(deploySource, /^run_schema_migration \|\| exit 1$/gm) === 1,
  'deploy.sh: has one lifecycle-fenced migration call',
  'deploy.sh: expected exactly one lifecycle-fenced migration call');
expectIncludes('deploy.sh', deploySource,
  'identityd_deploy_state="fatal_hold"\n        echo "ERROR: migration failed and backup restore integrity check failed; leaving Node-RED and identityd stopped"',
  'catastrophic migration failure explicitly holds both services stopped');
expectIncludes('deploy.sh', deploySource,
  'if ! restart_node_red; then\n        [ "$exit_status" -ne 0 ] || exit_status=1\n    fi\n    if ! restore_identityd_prior_state; then',
  'EXIT restoration handles Node-RED before identityd and preserves failure status');
expectIncludes('deploy.sh', deploySource,
  'trap \'deploy_exit_handler $?\' EXIT\n    trap \'exit 130\' INT\n    trap \'exit 143\' TERM',
  'uses one EXIT cleanup path with signal-specific exit status');
expectIncludes('deploy.sh', deploySource,
  'if ! identityd_service enable; then\n    echo "ERROR: failed to enable identityd" >&2\n    exit 1\nfi\nidentityd_service start\nif ! wait_for_identityd_ready; then',
  'final activation starts only after the quiescence gap and waits for readiness');
expectCondition(identityEnabledAt >= 0 && identityReadyAt > identityEnabledAt,
  'deploy.sh: final readiness follows identityd enable/start',
  'deploy.sh: final identityd readiness must follow enable/start');
expectIncludes('deploy.sh', deploySource,
  'identityd_deploy_state="disarmed"\necho "OK"',
  'disarms restoration only after final readiness succeeds');

expectIncludes('deploy.sh', deploySource, 'if [ -e "$DB_PATH-wal" ] || [ -e "$DB_PATH-shm" ] || [ -e "$DB_PATH-journal" ]; then', 'preserves the missing-DB sidecar guard');
expectIncludes('deploy.sh', deploySource,
  'swap_call flipTo "$DEPLOY_STAMP" >/dev/null\necho "OK: flipped /srv/node-red/flows.json -> payloads/$DEPLOY_STAMP"\n\n/etc/init.d/node-red restart || true',
  'retains the direct Node-RED restart immediately after the live payload flip and its existing log');
expectIncludes('deploy.sh', deploySource, 'swap_call flipTo "$PREV_STAMP" >/dev/null\n        /etc/init.d/node-red restart || true', 'retains the rollback restart');
expectCondition(countMatches(deploySource, /\/etc\/init\.d\/node-red restart/g) === 2,
  'deploy.sh: only payload flip and rollback directly restart Node-RED',
  'deploy.sh: expected exactly two direct Node-RED restarts for payload flip and rollback');

const flowRelativePaths = profiles.map((profile) => `${profile}/files/usr/share/flows.json`);
const identityGateIds = [
  'sync-bootstrap-build',
  'sync-outbox-build',
  'sync-pending-build',
  'sync-force-build',
  'command-ack-build-batch',
  'sync-state-build',
  'al-link-build-req',
];
const sentinelReaderIds = ['sys-stats-fn', ...identityGateIds];
const syncBuilderIds = [
  'sync-bootstrap-build',
  'sync-outbox-build',
  'sync-pending-build',
  'sync-force-build',
];
const restartOwnerContracts = [
  ['al-link-restart-node-red', 'account_link', 10],
  ['al-unlink-restart-node-red', 'account_unlink', 2],
];
const expectedNodeLibs = {
  'sync-bootstrap-build': [{ var: 'crypto', module: 'crypto' }, { var: 'osiDb', module: 'osi-db-helper' }],
  'sync-outbox-build': [{ var: 'osiDb', module: 'osi-db-helper' }],
  'sync-pending-build': [{ var: 'osiDb', module: 'osi-db-helper' }],
  'sync-force-build': [{ var: 'crypto', module: 'crypto' }, { var: 'osiDb', module: 'osi-db-helper' }, { var: 'osiCloudHttp', module: 'osi-cloud-http' }],
  'command-ack-build-batch': [{ var: 'osiDb', module: 'osi-db-helper' }],
  'sync-state-build': [{ var: 'crypto', module: 'crypto' }, { var: 'osiDb', module: 'osi-db-helper' }],
  'al-link-build-req': [{ var: 'osiDb', module: 'osi-db-helper' }],
  'al-link-restart-node-red': [],
  'al-unlink-restart-node-red': [],
};
const sentinelPath = '/var/run/osi-identity-restart.json';
const requestDirectory = '/var/run/osi-node-red-restart-requests';
const localRestartReader = [
  'function gatewayIdentityRestartPending() {',
  "  const fs = global.get('fs');",
  '  if (!fs) {',
  "    node.warn('Gateway identity restart check: fs global is unavailable; blocking identity-sensitive work');",
  '    return true;',
  '  }',
  "  const statePath = '/var/run/osi-identity-restart.json';",
  '  if (!fs.existsSync(statePath)) return false;',
  '  try {',
  "    JSON.parse(fs.readFileSync(statePath, 'utf8'));",
  '    return true;',
  '  } catch (error) {',
  "    node.warn('Gateway identity restart state is unreadable; blocking identity-sensitive work: ' + String(error && error.message ? error.message : error));",
  '    return true;',
  '  }',
  '}',
].join('\n');
const protectedNodeHashes = {
  'al-link-validate': 'c6dc24e4f754e3d6d5dde77d5352d96e6105b958349e549e8896d50bf64bf2d7',
  'sync-init-fn': '2ecba63b87c0389c9f1273267346101d861d5a076abe1410ec496111fe502263',
};
const migrationPreflightHashes = {
  'sync-bootstrap-build': ['\nfunction normalizeCloudServerUrl', '9ae98d1f0fba0086ebc1dbe556a58656f7bd52d74b6ca81d085735df3950fe46'],
  'sync-outbox-build': ['\nfunction normalizeCloudServerUrl', 'abbebaac2e03f06562d6e6c49ff10fbca800c229d8cf5879a9af3ba0a0558c56'],
  'sync-pending-build': ['\nfunction normalizeCloudServerUrl', '6f4fbe26fd5954042736f07e05d99c40ffe55ad1bff2a35097c8fec32f49570b'],
  'sync-force-build': ['\nfunction recordFailure', 'df5cb5ca7dae8dc1bfeba7b8546e1d215ead1f71730f426400bbafb02f07864d'],
};

function executeRestartOwner(func, msgId, options) {
  const fixtureOptions = options || {};
  const calls = { mkdir: [], write: [], rename: [], unlink: [] };
  const warnings = [];
  const statuses = [];
  const fsGlobal = {
    mkdirSync(...args) {
      calls.mkdir.push(args);
      if (fixtureOptions.mkdirError) throw fixtureOptions.mkdirError;
    },
    writeFileSync(...args) {
      calls.write.push(args);
      if (fixtureOptions.writeError) throw fixtureOptions.writeError;
    },
    renameSync(...args) {
      calls.rename.push(args);
      if (fixtureOptions.renameError) throw fixtureOptions.renameError;
    },
    unlinkSync(...args) { calls.unlink.push(args); },
  };
  const globalContext = { get(key) { return key === 'fs' && fixtureOptions.fsAvailable !== false ? fsGlobal : null; } };
  const nodeContext = {
    warn(value) { warnings.push(String(value)); },
    status(value) { statuses.push(value); },
  };
  const fixedDate = { now() { return 1700000000123; } };
  const fixedMath = { floor: Math.floor, random() { return fixtureOptions.randomValue == null ? 0.125 : fixtureOptions.randomValue; } };
  const execute = new Function('msg', 'global', 'node', 'Buffer', 'Date', 'Math', func);
  const msg = msgId === undefined ? {} : { _msgid: msgId };
  const result = execute(msg, globalContext, nodeContext, Buffer, fixedDate, fixedMath);
  return { calls, warnings, statuses, result, msg };
}

function verifyRestartOwnerExecution(label, func, reason, delaySeconds) {
  const hostileId = '../../etc/passwd ?#\u2603';
  const safeHostileId = Buffer.from(hostileId, 'utf8').toString('hex');
  const hostile = executeRestartOwner(func, hostileId, { randomValue: 0.125 });
  expectCondition(hostile.calls.mkdir.length === 1
      && hostile.calls.mkdir[0][0] === requestDirectory
      && JSON.stringify(hostile.calls.mkdir[0][1]) === JSON.stringify({ recursive: true, mode: 0o700 }),
    `${label}: creates the private request directory with mode 0700`,
    `${label}: must mkdir the request directory recursively with mode 0700`);
  expectCondition(hostile.calls.write.length === 1 && hostile.calls.rename.length === 1,
    `${label}: writes one temporary file and renames it once`,
    `${label}: expected one write and one atomic rename`);
  if (hostile.calls.write.length === 1 && hostile.calls.rename.length === 1) {
    const [tempPath, rawJson, writeOptions] = hostile.calls.write[0];
    const [renamedFrom, finalPath] = hostile.calls.rename[0];
    let request = null;
    try { request = JSON.parse(rawJson); } catch (error) { fail(`${label}: request JSON is invalid: ${error.message}`); }
    expectCondition(path.dirname(finalPath) === requestDirectory
        && finalPath === `${requestDirectory}/${reason}-${safeHostileId}.json`,
      `${label}: hostile msg._msgid is deterministically encoded inside the request directory`,
      `${label}: final request path escaped or is not keyed by the safe msg._msgid encoding: ${finalPath}`);
    expectCondition(tempPath !== finalPath && renamedFrom === tempPath && tempPath.startsWith(finalPath + '.') && tempPath.endsWith('.tmp'),
      `${label}: unique temporary path is renamed to the deterministic final path`,
      `${label}: temporary publication path is not a unique child of the deterministic final path`);
    expectCondition(JSON.stringify(writeOptions) === JSON.stringify({ encoding: 'utf8', mode: 0o600, flag: 'wx' }),
      `${label}: temporary request uses mode 0600 and exclusive creation`,
      `${label}: temporary request must use utf8, mode 0600, and flag wx`);
    expectCondition(request && JSON.stringify(Object.keys(request)) === JSON.stringify(['reason', 'delaySeconds', 'requestedAtEpoch'])
        && request.reason === reason && request.delaySeconds === delaySeconds && request.requestedAtEpoch === 1700000000,
      `${label}: final JSON has exactly reason, delaySeconds, and requestedAtEpoch`,
      `${label}: request JSON does not match the exact three-field contract`);
  }
  expectCondition(Array.isArray(hostile.result) && hostile.result[0] === hostile.msg && hostile.result[1] === null,
    `${label}: successful publication uses only the success output`,
    `${label}: successful publication must return [msg, null]`);

  const first = executeRestartOwner(func, 'request-one', { randomValue: 0.25 });
  const second = executeRestartOwner(func, 'request-two', { randomValue: 0.375 });
  const retry = executeRestartOwner(func, 'request-one', { randomValue: 0.5 });
  const firstFinal = first.calls.rename[0] && first.calls.rename[0][1];
  const secondFinal = second.calls.rename[0] && second.calls.rename[0][1];
  const retryFinal = retry.calls.rename[0] && retry.calls.rename[0][1];
  const firstTemp = first.calls.write[0] && first.calls.write[0][0];
  const retryTemp = retry.calls.write[0] && retry.calls.write[0][0];
  expectCondition(firstFinal && secondFinal && firstFinal !== secondFinal,
    `${label}: distinct msg._msgid values produce distinct final paths`,
    `${label}: final request path is not keyed by msg._msgid`);
  expectCondition(firstFinal && firstFinal === retryFinal && firstTemp && retryTemp && firstTemp !== retryTemp,
    `${label}: retries keep a deterministic final path and use a fresh temporary suffix`,
    `${label}: retries must keep the final path stable while changing the temporary path`);

  for (const [missingLabel, msgId] of [['missing', undefined], ['empty', '   ']]) {
    const invalid = executeRestartOwner(func, msgId, { randomValue: 0.625 });
    expectCondition(invalid.calls.mkdir.length === 0 && invalid.calls.write.length === 0 && invalid.calls.rename.length === 0
        && invalid.warnings.some((warning) => warning.includes('msg._msgid'))
        && invalid.statuses.some((status) => status && status.fill === 'red')
        && Array.isArray(invalid.result) && invalid.result[0] === null && invalid.result[1] === invalid.msg
        && invalid.msg.statusCode === 503 && invalid.msg.payload && invalid.msg.payload.success === false,
      `${label}: ${missingLabel} msg._msgid fails visibly before filesystem access`,
      `${label}: ${missingLabel} msg._msgid must warn, set red status, publish nothing, and use only the error output`);
  }

  const missingFs = executeRestartOwner(func, 'missing-fs', { fsAvailable: false });
  expectCondition(missingFs.calls.mkdir.length === 0 && missingFs.calls.write.length === 0
      && missingFs.warnings.some((warning) => warning.includes('fs global is unavailable'))
      && missingFs.statuses.some((status) => status && status.fill === 'red')
      && Array.isArray(missingFs.result) && missingFs.result[0] === null && missingFs.result[1] === missingFs.msg
      && missingFs.msg.statusCode === 503 && missingFs.msg.payload?.success === false,
    `${label}: missing fs fails through only the error output`,
    `${label}: missing fs must not preserve the success response or reach success wiring`);

  const mkdirError = Object.assign(new Error('m'.repeat(500)), { code: 'EACCES' });
  const mkdirFailure = executeRestartOwner(func, 'mkdir-failure', { mkdirError });
  expectCondition(mkdirFailure.calls.mkdir.length === 1 && mkdirFailure.calls.write.length === 0
      && mkdirFailure.calls.rename.length === 0 && mkdirFailure.calls.unlink.length === 0
      && mkdirFailure.warnings.length === 1
      && mkdirFailure.warnings[0].includes('central hub restart could not be queued')
      && mkdirFailure.statuses.some((status) => status && status.fill === 'red')
      && Array.isArray(mkdirFailure.result) && mkdirFailure.result[0] === null && mkdirFailure.result[1] === mkdirFailure.msg
      && mkdirFailure.msg.statusCode === 503 && mkdirFailure.msg.payload?.success === false
      && typeof mkdirFailure.msg.payload?.message === 'string'
      && mkdirFailure.msg.payload?.detail?.length === 200
      && JSON.stringify(mkdirFailure.msg.payload).length <= 512,
    `${label}: mkdir failure stops before publication and uses only the bounded error output`,
    `${label}: mkdir failure must warn, set red status, avoid publication and cleanup, and return one bounded 503 error`);

  const enospc = Object.assign(new Error('x'.repeat(500)), { code: 'ENOSPC' });
  const writeFailure = executeRestartOwner(func, 'write-failure', { writeError: enospc });
  expectCondition(writeFailure.calls.write.length === 1 && writeFailure.calls.rename.length === 0 && writeFailure.calls.unlink.length === 1
      && writeFailure.statuses.some((status) => status && status.fill === 'red')
      && Array.isArray(writeFailure.result) && writeFailure.result[0] === null && writeFailure.result[1] === writeFailure.msg
      && writeFailure.msg.statusCode === 503 && writeFailure.msg.payload?.success === false
      && writeFailure.msg.payload?.detail?.length === 200,
    `${label}: ENOSPC fails closed, cleans up, and uses only the error output`,
    `${label}: ENOSPC must never retain a success response or reach success wiring`);

  const renameError = Object.assign(new Error('fixture rename failure'), { code: 'EIO' });
  const renameFailure = executeRestartOwner(func, 'rename-failure', { renameError });
  expectCondition(renameFailure.calls.write.length === 1 && renameFailure.calls.rename.length === 1 && renameFailure.calls.unlink.length === 1
      && renameFailure.statuses.some((status) => status && status.fill === 'red')
      && Array.isArray(renameFailure.result) && renameFailure.result[0] === null && renameFailure.result[1] === renameFailure.msg
      && renameFailure.msg.statusCode === 503 && renameFailure.msg.payload?.success === false,
    `${label}: rename failure cleans up and uses only the error output`,
    `${label}: rename failure must never retain a success response or reach success wiring`);

  const longId = executeRestartOwner(func, 'x'.repeat(65), {});
  expectCondition(longId.calls.mkdir.length === 0 && longId.calls.write.length === 0 && longId.calls.rename.length === 0
      && longId.warnings.some((warning) => warning.includes('too long'))
      && longId.statuses.some((status) => status && status.fill === 'red')
      && Array.isArray(longId.result) && longId.result[0] === null && longId.result[1] === longId.msg
      && longId.msg.statusCode === 503 && longId.msg.payload?.success === false,
    `${label}: very long msg._msgid fails before filename construction`,
    `${label}: msg._msgid must enforce the 64-byte filename-key contract`);
}

function createSystemStatsNodeContext() {
  const values = new Map();
  return {
    get(key) { return values.get(key); },
    set(key, value) { values.set(key, value); },
    value(key) { return values.get(key); },
  };
}

function executeSystemStats(func, options, sharedContext) {
  const fixtureOptions = options || {};
  const warnings = [];
  const sentinelExists = fixtureOptions.sentinelExists === true;
  const sentinelRaw = fixtureOptions.sentinelRaw;
  const fsGlobal = {
    existsSync(filePath) {
      return filePath === sentinelPath && sentinelExists;
    },
    readFileSync(filePath) {
      if (filePath === '/sys/class/thermal/thermal_zone0/temp') return '42500\n';
      if (filePath === sentinelPath) {
        if (fixtureOptions.sentinelReadError) throw fixtureOptions.sentinelReadError;
        return sentinelRaw;
      }
      if (/^\/sys\/class\/hwmon\/[^/]+\/name$/.test(filePath)) {
        if (fixtureOptions.hwmonNameError) throw fixtureOptions.hwmonNameError;
        return fixtureOptions.hwmonName || 'not-a-pwm-fan\n';
      }
      throw new Error(`unexpected read: ${filePath}`);
    },
    readdirSync(filePath) {
      if (filePath !== '/sys/class/hwmon') throw new Error(`unexpected readdir: ${filePath}`);
      if (fixtureOptions.hwmonDirectoryError) throw fixtureOptions.hwmonDirectoryError;
      return fixtureOptions.hwmonDirectories || [];
    },
    accessSync(filePath) {
      if (filePath !== '/sys/class/pwm/pwmchip2') throw new Error(`unexpected access: ${filePath}`);
      if (fixtureOptions.pwmAccessError) throw fixtureOptions.pwmAccessError;
      if (fixtureOptions.pwmAccessError !== false) {
        throw Object.assign(new Error('pwm control absent'), { code: 'ENOENT' });
      }
    },
  };
  const osGlobal = {
    loadavg() { return [0.25, 0.5, 0.75]; },
    totalmem() { return 1024 * 1048576; },
    freemem() { return 256 * 1048576; },
    cpus() { return [{}, {}, {}, {}]; },
  };
  const globalContext = {
    get(key) {
      if (key === 'fs') return fsGlobal;
      if (key === 'os') return osGlobal;
      return null;
    },
  };
  const nodeApi = { warn(value) { warnings.push(String(value)); } };
  const functionContext = sharedContext || createSystemStatsNodeContext();
  const msg = {};
  const execute = new Function('msg', 'global', 'node', 'context', func);
  const result = execute(msg, globalContext, nodeApi, functionContext);
  return { result, msg, warnings, context: functionContext };
}

function auditRestartStateAccesses(source) {
  const properties = [];
  let propertyBaseUses = 0;
  let literalBracketUses = 0;
  for (const match of source.matchAll(/\brestartState\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    properties.push(match[1]);
    propertyBaseUses += 1;
  }
  for (const match of source.matchAll(/\brestartState\s*\[\s*(['"])([^'"]+)\1\s*\]/g)) {
    properties.push(match[2]);
    propertyBaseUses += 1;
    literalBracketUses += 1;
  }
  const allUses = countMatches(source, /\brestartState\b/g);
  const bracketUses = countMatches(source, /\brestartState\s*\[/g);
  const reviewedBareUses = countMatches(source, /\bvar\s+restartState\s*=/g)
    + countMatches(source, /!\s*restartState\b(?!\s*[.\[])/g)
    + countMatches(source, /\btypeof\s+restartState\b(?!\s*[.\[])/g)
    + countMatches(source, /\bArray\.isArray\(\s*restartState\s*\)/g);
  return {
    properties,
    hasDynamicBracketAccess: bracketUses !== literalBracketUses,
    hasUnreviewedBareUse: allUses !== propertyBaseUses + reviewedBareUses,
  };
}

function verifySystemStatsExecution(label, func) {
  const missing = executeSystemStats(func, {});
  expectCondition(missing.result === missing.msg && missing.msg.statusCode === 200
      && Object.prototype.hasOwnProperty.call(missing.msg.payload || {}, 'restartPending')
      && missing.msg.payload.restartPending === null,
    `${label}: missing restart sentinel returns restartPending null`,
    `${label}: missing restart sentinel must return HTTP 200 with an explicit restartPending null`);

  const privateEui = '0016C001F116EBF2';
  const validState = {
    version: 1,
    phase: 'restart_pending',
    reason: 'gateway_identity_change',
    restartAt: '2026-07-15T12:01:00Z',
    restartAtEpoch: 1784116860,
    restartNotBeforeUptime: 100,
    targetDeviceEui: privateEui,
    confidence: 'authoritative',
  };
  const valid = executeSystemStats(func, { sentinelExists: true, sentinelRaw: JSON.stringify(validState) });
  const publicState = valid.msg.payload && valid.msg.payload.restartPending;
  const publicPayload = JSON.stringify(valid.msg.payload || {});
  expectCondition(valid.msg.statusCode === 200
      && publicState
      && JSON.stringify(Object.keys(publicState)) === JSON.stringify(['restartAt', 'reason'])
      && publicState.restartAt === validState.restartAt
      && publicState.reason === validState.reason,
    `${label}: valid restart sentinel exposes only restartAt and reason`,
    `${label}: valid restart sentinel must expose exactly restartAt and reason`);
  expectCondition(!publicPayload.includes('targetDeviceEui')
      && !publicPayload.includes(privateEui)
      && !publicPayload.includes('restartAtEpoch')
      && !publicPayload.includes('restartNotBeforeUptime')
      && !publicPayload.includes('confidence'),
    `${label}: unauthenticated stats omit private and internal sentinel fields`,
    `${label}: unauthenticated stats leaked a private or internal sentinel field`);

  const defaultReason = executeSystemStats(func, {
    sentinelExists: true,
    sentinelRaw: JSON.stringify({ phase: 'restart_pending', restartAt: '2026-07-15T12:01:00Z' }),
  });
  expectCondition(defaultReason.msg.payload?.restartPending?.reason === 'gateway_identity_change'
      && JSON.stringify(Object.keys(defaultReason.msg.payload.restartPending)) === JSON.stringify(['restartAt', 'reason']),
    `${label}: missing sentinel reason uses the reviewed public fallback`,
    `${label}: missing sentinel reason must fall back to gateway_identity_change without adding fields`);

  const healing = executeSystemStats(func, {
    sentinelExists: true,
    sentinelRaw: JSON.stringify({ phase: 'healing', restartAt: null, reason: 'gateway_identity_change', targetDeviceEui: privateEui }),
  });
  expectCondition(healing.msg.statusCode === 200
      && JSON.stringify(Object.keys(healing.msg.payload?.restartPending || {})) === JSON.stringify(['restartAt', 'reason', 'status'])
      && healing.msg.payload?.restartPending?.restartAt === null
      && healing.msg.payload?.restartPending?.reason === 'gateway_identity_change'
      && healing.msg.payload?.restartPending?.status === 'blocked'
      && !JSON.stringify(healing.msg.payload || {}).includes(privateEui),
    `${label}: no-deadline healing state exposes a blocked public restart state`,
    `${label}: no-deadline healing state must return a blocked restartPending object without leaking the target EUI`);

  const expiredState = { phase: 'restart_pending', restartAt: '2000-01-01T00:00:00Z', reason: 'account_link' };
  const expired = executeSystemStats(func, { sentinelExists: true, sentinelRaw: JSON.stringify(expiredState) });
  expectCondition(expired.msg.payload?.restartPending?.restartAt === expiredState.restartAt
      && expired.msg.payload?.restartPending?.reason === expiredState.reason,
    `${label}: an expired pending deadline remains visible until daemon cleanup`,
    `${label}: stats must retain an expired pending deadline for the GUI in-progress state`);

  for (const [caseName, sentinelRaw] of [
    ['invalid JSON', '{'],
    ['array shape', '[]'],
    ['non-string deadline', JSON.stringify({ phase: 'restart_pending', restartAt: 1784116860, reason: 'gateway_identity_change' })],
  ]) {
    const malformed = executeSystemStats(func, { sentinelExists: true, sentinelRaw });
    expectCondition(malformed.msg.statusCode === 200
        && JSON.stringify(Object.keys(malformed.msg.payload?.restartPending || {})) === JSON.stringify(['restartAt', 'reason', 'status', 'error'])
        && malformed.msg.payload?.restartPending?.restartAt === null
        && malformed.msg.payload?.restartPending?.reason === 'gateway_identity_change'
        && malformed.msg.payload?.restartPending?.status === 'malformed'
        && typeof malformed.msg.payload?.restartPending?.error === 'string'
        && malformed.warnings.some((warning) => warning.includes('restart state')),
      `${label}: ${caseName} exposes a malformed public restart state`,
      `${label}: ${caseName} must return a malformed restartPending object and warn without failing system stats`);
  }

  const readFailure = executeSystemStats(func, {
    sentinelExists: true,
    sentinelReadError: Object.assign(new Error('fixture read failure'), { code: 'EIO' }),
  });
  expectCondition(readFailure.msg.statusCode === 200
      && JSON.stringify(Object.keys(readFailure.msg.payload?.restartPending || {})) === JSON.stringify(['restartAt', 'reason', 'status', 'error'])
      && readFailure.msg.payload?.restartPending?.restartAt === null
      && readFailure.msg.payload?.restartPending?.reason === 'gateway_identity_change'
      && readFailure.msg.payload?.restartPending?.status === 'unreadable'
      && readFailure.msg.payload?.restartPending?.error.includes('fixture read failure')
      && readFailure.warnings.some((warning) => warning.includes('restart state') && warning.includes('fixture read failure')),
    `${label}: unreadable restart sentinel exposes an unreadable public restart state`,
    `${label}: unreadable restart sentinel must return an unreadable restartPending object and warn without failing system stats`);

  const hwmonDirectoryFailure = executeSystemStats(func, {
    hwmonDirectoryError: new Error('fixture hwmon directory failure'),
  });
  expectCondition(hwmonDirectoryFailure.msg.statusCode === 200
      && hwmonDirectoryFailure.msg.payload?.fan_available === false
      && hwmonDirectoryFailure.warnings.some((warning) => warning.includes('/sys/class/hwmon')),
    `${label}: hwmon directory failure keeps the fan fallback and warns with context`,
    `${label}: hwmon directory failure must retain fan_available false and warn with the probed path`);

  const fanProbeFailures = executeSystemStats(func, {
    hwmonDirectories: ['hwmon0'],
    hwmonNameError: new Error('fixture fan name failure'),
    pwmAccessError: Object.assign(new Error('fixture pwm access failure'), { code: 'EACCES' }),
  });
  expectCondition(fanProbeFailures.msg.statusCode === 200
      && fanProbeFailures.msg.payload?.fan_available === false
      && fanProbeFailures.warnings.some((warning) => warning.includes('/sys/class/hwmon/hwmon0/name'))
      && fanProbeFailures.warnings.some((warning) => warning.includes('/sys/class/pwm/pwmchip2')),
    `${label}: fan probe failures retain the fallback and warn for each probed path`,
    `${label}: fan probe failures must retain fan_available false and warn for hwmon name and pwm paths`);

  const expectedAbsenceContext = createSystemStatsNodeContext();
  const missingPwmFirst = executeSystemStats(func, {
    pwmAccessError: Object.assign(new Error('pwm path missing'), { code: 'ENOENT' }),
  }, expectedAbsenceContext);
  const missingPwmAgain = executeSystemStats(func, {
    pwmAccessError: Object.assign(new Error('pwm parent is not a directory'), { code: 'ENOTDIR' }),
  }, expectedAbsenceContext);
  expectCondition(missingPwmFirst.msg.statusCode === 200 && missingPwmAgain.msg.statusCode === 200
      && missingPwmFirst.msg.payload?.fan_available === false && missingPwmAgain.msg.payload?.fan_available === false
      && !missingPwmFirst.warnings.some((warning) => warning.includes('/sys/class/pwm/pwmchip2'))
      && !missingPwmAgain.warnings.some((warning) => warning.includes('/sys/class/pwm/pwmchip2')),
    `${label}: expected ENOENT and ENOTDIR fan absence stays quiet with the existing fallback`,
    `${label}: expected fan-path absence must retain HTTP 200 and fan_available false without repeated warnings`);

  const persistentContext = createSystemStatsNodeContext();
  const longDeniedMessage = `permission denied ${'x'.repeat(500)}`;
  const deniedFirst = executeSystemStats(func, {
    hwmonDirectoryError: Object.assign(new Error(longDeniedMessage), { code: 'EACCES' }),
  }, persistentContext);
  const deniedAgain = executeSystemStats(func, {
    hwmonDirectoryError: Object.assign(new Error(longDeniedMessage), { code: 'EACCES' }),
  }, persistentContext);
  const changedFailure = executeSystemStats(func, {
    hwmonDirectoryError: Object.assign(new Error('input output failure'), { code: 'EIO' }),
  }, persistentContext);
  const recovered = executeSystemStats(func, {}, persistentContext);
  const recurred = executeSystemStats(func, {
    hwmonDirectoryError: Object.assign(new Error('input output failure'), { code: 'EIO' }),
  }, persistentContext);
  const fanFailureState = persistentContext.value('sys_stats_fan_probe_failures');
  const hwmonWarnings = (result) => result.warnings.filter((warning) => warning.includes('/sys/class/hwmon'));
  expectCondition(hwmonWarnings(deniedFirst).length === 1 && hwmonWarnings(deniedAgain).length === 0,
    `${label}: a persistent unexpected fan failure warns once per path and signature`,
    `${label}: repeated EACCES must be deduplicated through shared Node-RED context`);
  expectCondition(hwmonWarnings(changedFailure).length === 1,
    `${label}: a changed unexpected fan failure warns again`,
    `${label}: changing the fan failure signature from EACCES to EIO must emit a new warning`);
  expectCondition(hwmonWarnings(recovered).length === 0 && hwmonWarnings(recurred).length === 1,
    `${label}: successful fan-probe recovery resets warning deduplication`,
    `${label}: a successful probe must clear its signature so the same later regression warns again`);
  expectCondition(fanFailureState && typeof fanFailureState['/sys/class/hwmon'] === 'string'
      && fanFailureState['/sys/class/hwmon'].length <= 170,
    `${label}: remembered fan failure signatures are bounded`,
    `${label}: fan failure context must retain a bounded per-path signature`);

  const pruneContext = createSystemStatsNodeContext();
  const currentProbePath = '/sys/class/hwmon/hwmon-current/name';
  const disappearedProbePath = '/sys/class/hwmon/hwmon-disappeared/name';
  const identicalProbeSignature = 'EIO:churn fixture failure';
  pruneContext.set('sys_stats_fan_probe_failures', {
    [currentProbePath]: identicalProbeSignature,
    [disappearedProbePath]: identicalProbeSignature,
  });
  const prunePass = executeSystemStats(func, {
    hwmonDirectories: ['hwmon-current'],
    hwmonNameError: Object.assign(new Error('churn fixture failure'), { code: 'EIO' }),
  }, pruneContext);
  const prunedState = pruneContext.value('sys_stats_fan_probe_failures') || {};
  const prunedChildPaths = Object.keys(prunedState).filter((probePath) => /^\/sys\/class\/hwmon\/[^/]+\/name$/.test(probePath));
  expectCondition(!prunePass.warnings.some((warning) => warning.includes(currentProbePath))
      && JSON.stringify(prunedChildPaths) === JSON.stringify([currentProbePath]),
    `${label}: successful hwmon listing prunes disappeared children and keeps current deduplication`,
    `${label}: successful readdir must remove disappeared child signatures without re-warning the current identical failure`);
  const prunedPathRecurrence = executeSystemStats(func, {
    hwmonDirectories: ['hwmon-current', 'hwmon-disappeared'],
    hwmonNameError: Object.assign(new Error('churn fixture failure'), { code: 'EIO' }),
  }, pruneContext);
  expectCondition(prunedPathRecurrence.warnings.some((warning) => warning.includes(disappearedProbePath))
      && !prunedPathRecurrence.warnings.some((warning) => warning.includes(currentProbePath)),
    `${label}: disappeared hwmon path warns when it recurs while the current path remains deduplicated`,
    `${label}: a pruned child recurrence must warn again without re-warning the retained identical failure`);

  const churnDirectories = Array.from({ length: 40 }, (_, index) => `hwmon${index}`);
  const churnPaths = churnDirectories.map((directory) => `/sys/class/hwmon/${directory}/name`);
  const churnContext = createSystemStatsNodeContext();
  executeSystemStats(func, {
    hwmonDirectories: churnDirectories,
    hwmonNameError: Object.assign(new Error('churn fixture failure'), { code: 'EIO' }),
  }, churnContext);
  const churnState = churnContext.value('sys_stats_fan_probe_failures') || {};
  const churnKeys = Object.keys(churnState);
  const initiallyRetainedPaths = churnPaths.filter((probePath) => Object.prototype.hasOwnProperty.call(churnState, probePath));
  const retainedPath = initiallyRetainedPaths[0];
  const evictedPath = churnPaths.find((probePath) => !Object.prototype.hasOwnProperty.call(churnState, probePath));
  expectCondition(churnKeys.length <= 32 && retainedPath && evictedPath,
    `${label}: hwmon hotplug churn keeps the complete failure map at or below 32 entries`,
    `${label}: more than 32 unique hwmon failures must evict at least one entry and retain at most 32`);

  if (retainedPath && evictedPath) {
    const retainedDirectory = retainedPath.split('/')[4];
    const retainedRepeat = executeSystemStats(func, {
      hwmonDirectories: [retainedDirectory],
      hwmonNameError: Object.assign(new Error('churn fixture failure'), { code: 'EIO' }),
    }, churnContext);
    const afterPrune = churnContext.value('sys_stats_fan_probe_failures') || {};
    const remainingChildPaths = Object.keys(afterPrune).filter((probePath) => /^\/sys\/class\/hwmon\/[^/]+\/name$/.test(probePath));
    expectCondition(!retainedRepeat.warnings.some((warning) => warning.includes(retainedPath))
        && JSON.stringify(remainingChildPaths) === JSON.stringify([retainedPath]),
      `${label}: successful hwmon listing prunes disappeared children and retains identical current deduplication`,
      `${label}: stale hwmon child paths must be pruned while the current identical failure stays deduplicated`);

    const prunedPath = initiallyRetainedPaths.find((probePath) => probePath !== retainedPath);
    if (prunedPath) {
      const prunedDirectory = prunedPath.split('/')[4];
      const prunedRecurrence = executeSystemStats(func, {
        hwmonDirectories: [retainedDirectory, prunedDirectory],
        hwmonNameError: Object.assign(new Error('churn fixture failure'), { code: 'EIO' }),
      }, churnContext);
      expectCondition(prunedRecurrence.warnings.some((warning) => warning.includes(prunedPath))
          && !prunedRecurrence.warnings.some((warning) => warning.includes(retainedPath)),
        `${label}: a pruned hwmon path warns when it recurs while the retained path stays deduplicated`,
        `${label}: pruned path recurrence must warn again without regressing current-path deduplication`);
    } else {
      fail(`${label}: churn fixture did not retain a second path that could be pruned`);
    }

    const evictedDirectory = evictedPath.split('/')[4];
    const evictedRecurrence = executeSystemStats(func, {
      hwmonDirectories: [retainedDirectory, evictedDirectory],
      hwmonNameError: Object.assign(new Error('churn fixture failure'), { code: 'EIO' }),
    }, churnContext);
    expectCondition(evictedRecurrence.warnings.some((warning) => warning.includes(evictedPath)),
      `${label}: an evicted hwmon path warns when it recurs`,
      `${label}: cap-evicted path recurrence must become visible again`);
  }

  const failedListingContext = createSystemStatsNodeContext();
  const oversizedFailureMap = {};
  for (let index = 0; index < 40; index += 1) {
    oversizedFailureMap[`/sys/class/hwmon/stale${index}/name`] = `EIO:stale-${index}`;
  }
  failedListingContext.set('sys_stats_fan_probe_failures', oversizedFailureMap);
  executeSystemStats(func, {
    hwmonDirectoryError: Object.assign(new Error('listing unavailable'), { code: 'EIO' }),
  }, failedListingContext);
  const failedListingState = failedListingContext.value('sys_stats_fan_probe_failures') || {};
  expectCondition(Object.keys(failedListingState).length <= 32,
    `${label}: failure-map cap still applies when hwmon listing cannot prune stale children`,
    `${label}: defense-in-depth cap must hold even while /sys/class/hwmon readdir fails`);
}

let canonicalFlowsText = '';
for (const flowRelativePath of flowRelativePaths) {
  const flowsText = read(flowRelativePath);
  let flows = [];
  try {
    flows = JSON.parse(flowsText);
  } catch (error) {
    fail(`${flowRelativePath}: invalid JSON: ${error.message}`);
    continue;
  }
  expectCondition(Array.isArray(flows), `${flowRelativePath}: flow document is an array`, `${flowRelativePath}: flow document must be an array`);
  if (!Array.isArray(flows)) continue;
  const byId = new Map(flows.map((node) => [node && node.id, node]));
  const systemStats = byId.get('sys-stats-fn');
  if (!systemStats || typeof systemStats.func !== 'string') {
    fail(`${flowRelativePath}: missing system stats function sys-stats-fn`);
  } else {
    expectCondition(!Object.prototype.hasOwnProperty.call(systemStats, 'libs'),
      `${flowRelativePath}:sys-stats-fn: preserves its absent libs property`,
      `${flowRelativePath}:sys-stats-fn: must not add a libs property for the fs global`);
    for (const banned of ["global.get('cp')", 'spawn(', 'require(']) {
      expectExcludes(`${flowRelativePath}:sys-stats-fn`, systemStats.func, banned, `does not use ${banned}`);
    }
    const restartStateAudit = auditRestartStateAccesses(systemStats.func);
    const publicStateProperties = [...new Set(restartStateAudit.properties)].sort();
    expectCondition(JSON.stringify(publicStateProperties) === JSON.stringify(['reason', 'restartAt'])
        && !restartStateAudit.hasDynamicBracketAccess && !restartStateAudit.hasUnreviewedBareUse,
      `${flowRelativePath}:sys-stats-fn: restartState reads are allowlisted to reason and restartAt`,
      `${flowRelativePath}:sys-stats-fn: restartState access must use only direct reason/restartAt reads without aliases or dynamic brackets; got ${publicStateProperties.join(', ')}`);
    for (const privateField of ['phase', 'restartAtEpoch', 'restartNotBeforeUptime', 'targetDeviceEui', 'target_device_eui', 'requestedAt', 'confidence', 'version']) {
      expectExcludes(`${flowRelativePath}:sys-stats-fn`, systemStats.func, privateField, `does not reference private sentinel field ${privateField}`);
    }
    verifySystemStatsExecution(`${flowRelativePath}:sys-stats-fn`, systemStats.func);
  }
  const sentinelReaders = flows.filter((node) => node && typeof node.func === 'string' && node.func.includes(sentinelPath));
  expectCondition(
    sentinelReaders.length === sentinelReaderIds.length && sentinelReaders.every((node) => sentinelReaderIds.includes(node.id)),
    `${flowRelativePath}: only system stats and the seven identity gates read the restart sentinel`,
    `${flowRelativePath}: restart sentinel readers must be exactly ${sentinelReaderIds.join(', ')}; got ${sentinelReaders.map((node) => node.id).join(', ')}`
  );
  for (const nodeId of identityGateIds) {
    const node = byId.get(nodeId);
    if (!node || typeof node.func !== 'string') {
      fail(`${flowRelativePath}: missing identity-gate function ${nodeId}`);
      continue;
    }
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, localRestartReader, 'contains the exact fail-closed local restart reader');
    expectCondition(JSON.stringify(node.libs) === JSON.stringify(expectedNodeLibs[nodeId]),
      `${flowRelativePath}:${nodeId}: preserves its reviewed libs`,
      `${flowRelativePath}:${nodeId}: libs changed from ${JSON.stringify(expectedNodeLibs[nodeId])}`);
    for (const banned of ["global.get('cp')", 'spawn(', 'require(']) {
      expectExcludes(`${flowRelativePath}:${nodeId}`, node.func, banned, `does not use ${banned}`);
    }
  }
  for (const nodeId of syncBuilderIds) {
    const func = byId.get(nodeId) && byId.get(nodeId).func;
    if (!func) continue;
    const pendingCheckAt = func.indexOf('if (gatewayIdentityRestartPending()) {');
    const identityReadAt = func.indexOf('const identity = currentGatewayIdentity();');
    expectCondition(pendingCheckAt >= 0 && identityReadAt > pendingCheckAt,
      `${flowRelativePath}:${nodeId}: blocks before reading the boot identity`,
      `${flowRelativePath}:${nodeId}: restart check must precede currentGatewayIdentity()`);
    expectIncludes(`${flowRelativePath}:${nodeId}`, func, "source: 'gateway-identity'", 'records the existing gateway-identity error source');
    expectIncludes(`${flowRelativePath}:${nodeId}`, func, "const err = new Error('Gateway identity is being applied. The central hub will restart before syncing.');\n    err.statusCode = 503;\n    err.source = 'gateway-identity';\n    throw err;", 'throws a marked status 503 while the identity restart is pending');
  }
  const bootstrapBuilder = byId.get('sync-bootstrap-build');
  if (bootstrapBuilder) expectIncludes(`${flowRelativePath}:sync-bootstrap-build`, bootstrapBuilder.func, "const lastErrorSource = e && e.source === 'gateway-identity'\n    ? 'gateway-identity'\n    : 'bootstrap';", 'selects the outer error source from the caught error marker, not stale flow state');
  const commandAck = byId.get('command-ack-build-batch');
  if (commandAck) {
    expectIncludes(`${flowRelativePath}:command-ack-build-batch`, commandAck.func,
      'if (gatewayIdentityRestartPending()) {\n    await close();\n    return null;\n  }',
      'drops command ACK work while restart is pending');
  }
  const syncState = byId.get('sync-state-build');
  if (syncState) expectIncludes(`${flowRelativePath}:sync-state-build`, syncState.func, 'restartPending: gatewayIdentityRestartPending()', 'exposes the boolean restart state');
  const linkRequest = byId.get('al-link-build-req');
  if (linkRequest) {
    expectIncludes(`${flowRelativePath}:al-link-build-req`, linkRequest.func,
      "flow.set('al_server_password', null);\n  msg.statusCode = 503;\n  msg.payload = { message: 'Gateway identity is being applied. The central hub will restart before linking.' };\n  return [null, msg];",
      'clears the password and returns the second/error output with status 503');
  }
  for (const [nodeId, reason, delaySeconds] of restartOwnerContracts) {
    const node = byId.get(nodeId);
    if (!node || typeof node.func !== 'string') {
      fail(`${flowRelativePath}: missing restart-owner function ${nodeId}`);
      continue;
    }
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, "const fs = global.get('fs');", 'uses the approved fs global');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, requestDirectory, 'publishes into the daemon request directory');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, `reason: '${reason}', delaySeconds: ${delaySeconds}, requestedAtEpoch: Math.floor(Date.now() / 1000)`, 'publishes the exact three-field request contract');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, "const requestId = String((msg && msg._msgid) || '').trim();", 'requires the Node-RED message identity');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, ".slice(0, 200)", 'bounds filesystem error detail returned to the operator');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, "const requestIdBytes = Buffer.from(requestId, 'utf8');", 'measures the UTF-8 message identity');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, 'if (requestIdBytes.length > 64) {', 'bounds the filename key before filesystem access');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, "const safeRequestId = requestIdBytes.toString('hex');", 'encodes msg._msgid into a path-safe deterministic key');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, `const finalPath = requestDir + '/${reason}-' + safeRequestId + '.json';`, 'keys the deterministic final path by the safe message identity');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, "tempPath = finalPath + '.' + uniqueSuffix + '.tmp';", 'uses a unique temporary suffix for retry-safe publication');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, "fs.writeFileSync(tempPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600, flag: 'wx' });\n  fs.renameSync(tempPath, finalPath);", 'publishes atomically through a unique temporary file');
    expectIncludes(`${flowRelativePath}:${nodeId}`, node.func, 'node.status({', 'reports the scheduled restart');
    expectCondition(node.outputs === 2, `${flowRelativePath}:${nodeId}: has separate success and error outputs`, `${flowRelativePath}:${nodeId}: must declare two outputs`);
    const expectedWires = reason === 'account_link'
      ? [['al-link-resp', 'al-link-clear-state', 'al-link-bootstrap-link-out'], ['al-link-resp']]
      : [['al-unlink-resp', 'al-link-clear-state'], ['al-unlink-resp']];
    expectCondition(JSON.stringify(node.wires) === JSON.stringify(expectedWires),
      `${flowRelativePath}:${nodeId}: failure reaches only the HTTP response`,
      `${flowRelativePath}:${nodeId}: success/error wiring must be ${JSON.stringify(expectedWires)}`);
    expectCondition(JSON.stringify(node.libs) === JSON.stringify(expectedNodeLibs[nodeId]), `${flowRelativePath}:${nodeId}: keeps libs empty`, `${flowRelativePath}:${nodeId}: libs must remain []`);
    for (const banned of ["global.get('cp')", 'spawn(', '/etc/init.d/node-red']) {
      expectExcludes(`${flowRelativePath}:${nodeId}`, node.func, banned, `does not use ${banned}`);
    }
    verifyRestartOwnerExecution(`${flowRelativePath}:${nodeId}`, node.func, reason, delaySeconds);
  }
  for (const [nodeId, expectedHash] of Object.entries(protectedNodeHashes)) {
    const node = byId.get(nodeId);
    expectCondition(node && sha256(node.func || '') === expectedHash,
      `${flowRelativePath}:${nodeId}: protected function is byte-identical to its pre-edit snapshot`,
      `${flowRelativePath}:${nodeId}: protected function changed from its pre-edit snapshot`);
  }
  for (const [nodeId, [endMarker, expectedHash]] of Object.entries(migrationPreflightHashes)) {
    const node = byId.get(nodeId);
    if (!node || typeof node.func !== 'string') continue;
    const startAt = node.func.indexOf('async function runGatewayMigrationPreflight');
    const endAt = node.func.indexOf(endMarker, startAt);
    const body = startAt >= 0 && endAt > startAt ? node.func.slice(startAt, endAt) : '';
    expectCondition(sha256(body) === expectedHash,
      `${flowRelativePath}:${nodeId}: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot`,
      `${flowRelativePath}:${nodeId}: runGatewayMigrationPreflight changed from its pre-edit snapshot`);
  }
  if (!canonicalFlowsText) canonicalFlowsText = flowsText;
  else expectCondition(flowsText === canonicalFlowsText, `${flowRelativePath}: byte-identical flow mirror`, `${flowRelativePath}: differs from bcm2712 flows`);
}

let silentCatchBaseline = null;
let sizeAllowances = null;
try {
  silentCatchBaseline = JSON.parse(silentCatchBaselineSource);
  sizeAllowances = JSON.parse(sizeAllowancesSource);
} catch (error) {
  fail(`Task 4 ratchet JSON is invalid: ${error.message}`);
}
if (silentCatchBaseline) {
  expectCondition(silentCatchBaseline.profiles?.bcm2712?.silentCatchCount === 189 && silentCatchBaseline.profiles?.bcm2709?.silentCatchCount === 189,
    'silent-catch baseline records 189 for both maintained profiles',
    'silent-catch baseline must be 189 for both maintained profiles after AgroLink Phase B exposes shared-read failures');
  expectIncludes('silent-catch baseline', String(silentCatchBaseline.generatedFrom || ''), 'registration compensation now reports failures instead of swallowing them', 'records the PR #149 compensation cleanup');
  expectIncludes('silent-catch baseline', String(silentCatchBaseline.generatedFrom || ''), 'AgroLink Phase A', 'records the scoped-access auth cleanup');
  expectIncludes('silent-catch baseline', String(silentCatchBaseline.generatedFrom || ''), 'AgroLink Phase B shared reads', 'records the scoped-access shared-read cleanup');
}
// Ownership split (refactor-program A0 repair commit 3): the numeric ceilings
// (max_chars / max_total) in scripts/verify-flows-size-ratchet-allowances.json are now
// owned exclusively by scripts/verify-flows-size-ratchet.js - that script enforces every
// absolute ceiling and rejects stale/malformed entries. This verifier keeps only the
// identity-specific invariants: that each node this feature grew still has an owned
// entry at all (so a later PR cannot silently drop the entry and re-widen the node with
// no ceiling), and that its reason still documents the identity-restart-sentinel
// provenance. It does not know or care what the numeric ceiling is.
if (sizeAllowances) {
  const identityGrowthNodeIds = [
    'sync-bootstrap-build',
    'sync-outbox-build',
    'sync-pending-build',
    'sync-force-build',
    'command-ack-build-batch',
    'sync-state-build',
    'al-link-build-req',
    'al-link-restart-node-red',
    'al-unlink-restart-node-red',
  ];
  for (const nodeId of identityGrowthNodeIds) {
    expectCondition(Boolean(sizeAllowances.node_allowances?.[nodeId]),
      `size allowance ${nodeId}: owned entry present`,
      `size allowance ${nodeId}: expected an owned allowances entry (general ratchet owns its ceiling; identity owns only the reason)`);
    expectIncludes(`size allowance ${nodeId}`, String(sizeAllowances.node_allowances?.[nodeId]?.reason || ''), 'live identity restart sentinel (Option C Slice 1)', 'declares Task 4 growth');
  }
  expectCondition(Boolean(sizeAllowances.node_allowances?.['sys-stats-fn']),
    'size allowance sys-stats-fn: owned entry present',
    'size allowance sys-stats-fn: expected an owned allowances entry (general ratchet owns its ceiling; identity owns only the reason)');
  expectIncludes('size allowance sys-stats-fn', String(sizeAllowances.node_allowances?.['sys-stats-fn']?.reason || ''), 'filtered restartPending status (Option C Slice 1b)', 'declares Task 5 growth');
}

if (lifecycleTestSource) {
  const lifecycleResult = spawnSync('sh', [path.join(repoRoot, lifecycleTestPath)], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (lifecycleResult.status === 0) {
    ok(`${lifecycleTestPath}: ${lifecycleResult.stdout.trim()}`);
  } else {
    fail(`${lifecycleTestPath}: lifecycle harness failed (${lifecycleResult.status}): ${(lifecycleResult.stderr || lifecycleResult.stdout).trim()}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`${failures.length} live gateway identity verification failure(s)`);
  process.exit(1);
}

console.log('Live gateway identity verification passed.');
