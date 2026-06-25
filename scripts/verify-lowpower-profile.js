#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROFILE = 'conf/lowpower_raspberrypi_bcm27xx_bcm2709';
const PROFILE_ROOT = path.join(REPO_ROOT, PROFILE);
const CONFIG_PATH = path.join(PROFILE_ROOT, '.config');
const BOOT_PATCH_PATH = path.join(PROFILE_ROOT, 'patches/boot-config.patch');
const FILES_PATH = path.join(PROFILE_ROOT, 'files');
const FILES_OVERLAY_PATH = path.join(PROFILE_ROOT, 'files-overlay');
const LOWPOWER_DEFAULT_PATH = path.join(FILES_OVERLAY_PATH, 'etc/uci-defaults/99_osi_lowpower_defaults');
const MAKEFILE_PATH = path.join(REPO_ROOT, 'Makefile');
const SETTINGS_PATH = path.join(REPO_ROOT, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js');
const MQTT_TOPIC_CHECK_PATH = path.join(REPO_ROOT, 'scripts/check-mqtt-topics.sh');
const PROFILE_PARITY_PATH = path.join(REPO_ROOT, 'scripts/verify-profile-parity.js');
const SHARED_PROFILE_ROOTS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712',
  'conf/full_raspberrypi_bcm27xx_bcm2709',
];

let failures = 0;
let warnings = 0;

function fail(message) {
  failures += 1;
  console.error('FAIL: ' + message);
}

function warn(message) {
  warnings += 1;
  console.warn('WARN: ' + message);
}

function ok(message) {
  console.log('OK:   ' + message);
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function expectFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} missing at ${path.relative(REPO_ROOT, filePath)}`);
    return false;
  }
  ok(`${label} present`);
  return true;
}

function hasLine(content, line) {
  return content.split(/\r?\n/).includes(line);
}

function expectPackageSet(config, pkg) {
  const line = `CONFIG_PACKAGE_${pkg}=y`;
  if (!hasLine(config, line)) {
    fail(`${pkg} must be selected`);
    return;
  }
  ok(`${pkg} selected`);
}

function expectPackageNotSet(config, pkg) {
  const line = `CONFIG_PACKAGE_${pkg}=y`;
  if (hasLine(config, line)) {
    fail(`${pkg} must not be selected`);
    return;
  }
  ok(`${pkg} not selected`);
}

function warnIfPackageSet(config, pkg, reason) {
  const line = `CONFIG_PACKAGE_${pkg}=y`;
  if (hasLine(config, line)) {
    warn(`${pkg} still selected: ${reason}`);
    return;
  }
  ok(`${pkg} not selected`);
}

function expectContains(content, needle, label) {
  if (!content.includes(needle)) {
    fail(`${label} missing ${needle}`);
    return;
  }
  ok(`${label} contains ${needle}`);
}

function expectExecutable(filePath, label) {
  if (!expectFile(filePath, label)) return;
  const mode = fs.statSync(filePath).mode;
  if ((mode & 0o111) === 0) {
    fail(`${label} must be executable`);
    return;
  }
  ok(`${label} executable`);
}

function expectNotContains(content, needle, label) {
  if (content.includes(needle)) {
    fail(`${label} must not contain ${needle}`);
    return;
  }
  ok(`${label} omits ${needle}`);
}

if (!fs.existsSync(PROFILE_ROOT)) {
  fail(`${PROFILE} does not exist`);
} else {
  ok(`${PROFILE} exists`);
}

if (!expectFile(CONFIG_PATH, 'low-power .config')) process.exit(1);
if (!expectFile(BOOT_PATCH_PATH, 'low-power boot patch')) process.exit(1);
if (!expectFile(LOWPOWER_DEFAULT_PATH, 'low-power uci-default')) process.exit(1);

const config = readFile(CONFIG_PATH);
const bootPatch = readFile(BOOT_PATCH_PATH);
const lowpowerDefault = readFile(LOWPOWER_DEFAULT_PATH);
const makefile = readFile(MAKEFILE_PATH);
const settings = readFile(SETTINGS_PATH);
const mqttTopicCheck = readFile(MQTT_TOPIC_CHECK_PATH);
const profileParity = readFile(PROFILE_PARITY_PATH);

expectPackageSet(config, 'luci-nginx');
expectPackageSet(config, 'luci-base');
expectPackageSet(config, 'luci-mod-admin-full');
expectPackageSet(config, 'luci-mod-network');
expectPackageSet(config, 'luci-mod-status');
expectPackageSet(config, 'luci-mod-system');
expectPackageSet(config, 'luci-app-chirpstack');
expectPackageSet(config, 'luci-app-chirpstack-apps');
expectPackageSet(config, 'luci-app-chirpstack-chirpstack');
expectPackageSet(config, 'luci-app-chirpstack-concentratord');
expectPackageSet(config, 'luci-app-chirpstack-concentratord-target-rpi');
expectPackageSet(config, 'luci-app-chirpstack-mqtt-forwarder');
expectPackageSet(config, 'luci-app-chirpstack-mqtt-forwarder-single');
expectPackageSet(config, 'chirpstack');
expectPackageSet(config, 'chirpstack-concentratord');
expectPackageSet(config, 'chirpstack-concentratord-target-rpi');
expectPackageSet(config, 'chirpstack-mqtt-forwarder');
expectPackageSet(config, 'chirpstack-mqtt-forwarder-single');
expectPackageSet(config, 'mosquitto-nossl');
expectPackageSet(config, 'mosquitto-client-nossl');
expectPackageSet(config, 'libmosquitto-nossl');
expectPackageSet(config, 'uhubctl');
expectPackageSet(config, 'tailscale');

[
  'openvpn-openssl',
  'wireguard-tools',
  'luci-proto-wireguard',
  'luci-app-watchcat',
  'luci-app-package-manager',
  'chirpstack-gateway-mesh',
  'chirpstack-mqtt-forwarder-mesh',
  'chirpstack-udp-forwarder',
  'chirpstack-udp-forwarder-single',
  'luci-app-chirpstack-gateway-mesh',
  'luci-app-chirpstack-mqtt-forwarder-mesh',
  'luci-app-chirpstack-udp-forwarder',
  'luci-app-chirpstack-udp-forwarder-single',
  'kmod-usb-gadget',
  'kmod-usb-hid',
  'kmod-usb-serial',
  'kmod-usb-serial-ftdi',
  'kmod-usb-acm',
  'kmod-sound-core',
  'kmod-sound-arm-bcm2835',
].forEach((pkg) => expectPackageNotSet(config, pkg));

warnIfPackageSet(config, 'redis-server', 'remove only after Redis-disabled Pi boot/uplink smoke passes');
[
  'CONFIG_KERNEL_DEBUG_FS=y',
  'CONFIG_KERNEL_KALLSYMS=y',
  'CONFIG_KERNEL_DEBUG_KERNEL=y',
  'CONFIG_KERNEL_DEBUG_INFO=y',
  'CONFIG_KERNEL_KEXEC=y',
  'CONFIG_KERNEL_CRASH_DUMP=y',
].forEach((symbol) => {
  if (hasLine(config, symbol)) warn(`${symbol} remains enabled; demote only after defconfig/build proves removable`);
  else ok(`${symbol} not enabled`);
});

expectContains(bootPatch, 'dtparam=spi=on', 'boot patch');
expectContains(bootPatch, 'dtparam=audio=off', 'boot patch');
expectContains(bootPatch, 'hdmi_blanking=2', 'boot patch');
expectNotContains(bootPatch, 'enable_uart=1', 'boot patch');
expectNotContains(bootPatch, 'dtparam=i2c1=on', 'boot patch');
expectNotContains(bootPatch, 'dtparam=i2c_arm=on', 'boot patch');
expectNotContains(bootPatch, 'dtoverlay=dwc2', 'boot patch');

[
  "set osi-lowpower.main.enabled='1'",
  "set osi-lowpower.main.window_start='02:00'",
  "set osi-lowpower.main.window_duration_minutes='60'",
  "set osi-lowpower.main.usb_hubs='1-1 2'",
  "set osi-lowpower.main.cloud_window_required='1'",
  "set osi-lowpower.main.disable_pi_tailscale='1'",
  "set osi-gateway-gps.main.enabled='0'",
  'commit osi-lowpower',
  'commit osi-gateway-gps',
  '/etc/init.d/osi-lowpower enable',
].forEach((needle) => expectContains(lowpowerDefault, needle, 'low-power uci-default'));

const filesStat = fs.lstatSync(FILES_PATH);
if (!filesStat.isSymbolicLink()) {
  fail(`${PROFILE}/files must be a symlink to the shared full bcm2709 payload`);
} else {
  const target = fs.readlinkSync(FILES_PATH);
  if (target !== '../full_raspberrypi_bcm27xx_bcm2709/files') {
    fail(`${PROFILE}/files points to ${target}, expected ../full_raspberrypi_bcm27xx_bcm2709/files`);
  } else {
    ok(`${PROFILE}/files shares full bcm2709 payload`);
  }
}

if (fs.existsSync(path.join(FILES_OVERLAY_PATH, 'usr/share/flows.json'))) {
  fail('low-power profile must not carry a divergent flows.json overlay');
} else {
  ok('low-power profile does not overlay flows.json');
}

expectContains(makefile, 'files-overlay', 'Makefile switch-env');
expectContains(makefile, '.tmp-openwrt-files', 'Makefile switch-env');
expectContains(settings, "fs: require('fs')", 'Node-RED settings.js functionGlobalContext');
expectContains(mqttTopicCheck, 'conf/lowpower_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json', 'check-mqtt-topics.sh');
expectContains(profileParity, "'files/etc/init.d/osi-lowpower'", 'profile parity verifier');
expectContains(profileParity, "'files/usr/libexec/osi-lowpower-window.sh'", 'profile parity verifier');

SHARED_PROFILE_ROOTS.forEach((profileRoot) => {
  expectExecutable(
    path.join(REPO_ROOT, profileRoot, 'files/etc/init.d/osi-lowpower'),
    `${profileRoot} osi-lowpower init`
  );
  expectExecutable(
    path.join(REPO_ROOT, profileRoot, 'files/usr/libexec/osi-lowpower-window.sh'),
    `${profileRoot} osi-lowpower controller`
  );
});

if (failures > 0) {
  console.error(`\n${failures} low-power profile check(s) failed, ${warnings} warning(s)`);
  process.exit(1);
}

console.log(`\nLow-power profile verification passed with ${warnings} warning(s).`);
