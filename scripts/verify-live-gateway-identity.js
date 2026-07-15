#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
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
