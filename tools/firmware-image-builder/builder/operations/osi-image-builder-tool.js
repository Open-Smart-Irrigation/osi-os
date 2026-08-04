#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { lstat, mkdir, open, readlink, readdir, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

const WORKTREE = '/workdir';
const OPERATIONS = new Set(['activate-target', 'copy-feed-config', 'update-feeds', 'verify-image', 'mirror-gui']);
const TARGET_ENVIRONMENTS = new Set([
  'full_raspberrypi_bcm27xx_bcm2709',
  'full_raspberrypi_bcm27xx_bcm2712',
]);
const FIXED_PATHS = Object.freeze({
  feedSource: 'feeds.conf.default',
  feedDestination: 'openwrt/feeds.conf.default',
  feedStaging: '.osi-image-builder-feed-config-staging',
  guiSource: 'web/react-gui/build',
  guiDestination: 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui',
  guiStaging: '.osi-image-builder-gui-staging',
  imageDirectory: 'openwrt/bin/targets',
});
const CANONICAL_CHIRPSTACK_SOURCE = 'src-link chirpstack feeds/chirpstack-openwrt-feed';
const CANONICAL_CHIRPSTACK_DESTINATION = 'src-link chirpstack ../../feeds/chirpstack-openwrt-feed';
const UPDATE_FEEDS_ARGV = Object.freeze(['update', '-a']);
const ACTIVE_CONFIG_PATH = 'openwrt/.config';
const ACTIVE_CONFIG_TARGET = '../conf/.config';
const ACTIVE_CONFIG_MASK = '.osi-image-builder-active-config-mask';
const ACTIVE_CONFIG_REPLACEMENT = '.osi-image-builder-active-config-replacement';
const UPDATE_FEEDS_PATH = '/proc/self/fd/3/scripts/feeds';
const UPDATE_FEEDS_TOPDIR = '/proc/self/fd/3';
const FORWARDED_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);
const PROC_FD = '/proc/self/fd';
const DIRECTORY_FLAGS = constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const INSTALLED_NODE_BINARY = '/usr/local/bin/node';
const INSTALLED_MODULE_PROBE =
  '/opt/osi-image-builder/operations/osi-image-builder-module-probe.js';
const ADJACENT_MODULE_PROBE = fileURLToPath(
  new URL('./osi-image-builder-module-probe.js', import.meta.url),
);
const INSTALLED_PROBE_DEPENDENCIES = Object.freeze({
  nodeBinary: INSTALLED_NODE_BINARY,
  probeProgram: INSTALLED_MODULE_PROBE,
});
const TEST_PROBE_DEPENDENCIES = Object.freeze({
  nodeBinary: process.execPath,
  probeProgram: ADJACENT_MODULE_PROBE,
});
const MODULE_PROBE_TIMEOUT_MS = 15_000;
const NODE_MODULES = Object.freeze([
  ['@grpc/grpc-js', '@grpc/grpc-js'],
  [
    '@chirpstack/chirpstack-api',
    '@chirpstack/chirpstack-api',
    '@chirpstack/chirpstack-api/api/application_grpc_pb',
  ],
  ['google-protobuf', 'google-protobuf'],
  ['protobufjs', 'protobufjs'],
  ['osi-chameleon-helper', 'osi-chameleon-helper'],
  ['osi-chirpstack-helper', 'osi-chirpstack-helper'],
  ['osi-cloud-http', 'osi-cloud-http'],
  ['osi-db-helper', 'osi-db-helper'],
  ['osi-dendro-helper', 'osi-dendro-helper'],
  ['osi-health-helper', 'osi-health-helper'],
  ['osi-history-helper', 'osi-history-helper'],
  ['osi-history-sync-helper', 'osi-history-sync-helper'],
  ['osi-lib', 'osi-lib'],
  ['osi-command-ledger', './osi-command-ledger'],
  ['osi-dendro-analytics', './osi-dendro-analytics'],
  ['osi-zone-env', './osi-zone-env'],
  ['osi-history-router', './osi-history-router'],
  ['osi-journal', './osi-journal'],
  ['osi-device-writer', './osi-device-writer'],
  ['osi-uc512-normalize', './osi-uc512-normalize'],
  ['osi-lsn50-normalize', './osi-lsn50-normalize'],
]);
const ROOTFS_BY_PROFILE = Object.freeze({
  'DEVICE_rpi-5': {
    targetId: 'rpi-5',
    path: 'openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx',
    imageDirectory: 'bcm27xx/bcm2712',
    imagePrefix: 'chirpstack-gateway-os-',
    imageSuffix: '-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz',
  },
  'DEVICE_rpi-2': {
    targetId: 'rpi-2',
    path: 'openwrt/build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx',
    imageDirectory: 'bcm27xx/bcm2709',
    imagePrefix: 'chirpstack-gateway-os-',
    imageSuffix: '-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz',
  },
});

const TARGET_LINKS = Object.freeze([
  ['conf', '.config', (environment) => `${environment}/.config`],
  ['conf', 'files', (environment) => `${environment}/files`],
  ['conf', 'patches', (environment) => `${environment}/patches`],
  ['openwrt', '.config', () => '../conf/.config'],
  ['openwrt', 'files', () => '../conf/files'],
  ['openwrt', 'patches', () => '../conf/patches'],
]);

function fail(message) {
  process.stderr.write(`osi-image-builder-tool: ${message}\n`);
  process.exitCode = 2;
}

class OperationExitError extends Error {
  constructor(exitCode, message, report = false) {
    super(message);
    this.name = 'OperationExitError';
    this.exitCode = exitCode;
    this.report = report;
  }
}

function openActiveConfigDirectory(root) {
  let directory;
  try {
    directory = openSync(`${root}/openwrt`, DIRECTORY_FLAGS);
  } catch (error) {
    throw new Error('OpenWrt directory is not a stable directory', { cause: error });
  }
  const parent = `${PROC_FD}/${directory}`;
  const held = fstatSync(directory);
  const named = lstatSync(`${root}/openwrt`);
  if (!held.isDirectory() || named.isSymbolicLink() || !named.isDirectory() || !sameEntryIdentity(held, named)) {
    closeSync(directory);
    throw new Error('OpenWrt directory identity changed while being opened');
  }
  return {
    directory,
    directoryPath: parent,
    namedPath: `${root}/openwrt`,
    originalDirectory: held,
    path: `${parent}/.config`,
    maskPath: `${parent}/${ACTIVE_CONFIG_MASK}`,
    replacementPath: `${parent}/${ACTIVE_CONFIG_REPLACEMENT}`,
  };
}

function assertNamedOpenWrtDirectory(activeConfig) {
  const named = lstatSync(activeConfig.namedPath);
  const held = fstatSync(activeConfig.directory);
  if (
    !named.isDirectory()
    || named.isSymbolicLink()
    || !held.isDirectory()
    || !sameEntryIdentity(activeConfig.originalDirectory, named)
    || !sameEntryIdentity(activeConfig.originalDirectory, held)
  ) throw new Error('named OpenWrt directory identity changed during feeds update');
}

function assertExactActiveConfigLink(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('active OpenWrt config link is missing');
    throw new Error('active OpenWrt config link could not be inspected', { cause: error });
  }
  if (!stats.isSymbolicLink() || readlinkSync(path) !== ACTIVE_CONFIG_TARGET) {
    throw new Error('active OpenWrt config link is not the exact ../conf/.config symlink');
  }
}

function optionalStats(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function signalExitCode(signal) {
  const number = osConstants.signals[signal];
  return Number.isInteger(number) && number > 0 && number < 128 ? 128 + number : 255;
}

function createSignalForwarder(signalSource = process) {
  let child = null;
  let requestedSignal = null;
  const signalChildGroup = (signal) => {
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    try {
      signalSource.kill(-child.pid, signal);
    } catch {
      // Child completion supplies the authoritative result.
    }
  };
  const handlers = new Map(FORWARDED_SIGNALS.map((signal) => [signal, () => {
    if (requestedSignal === null) requestedSignal = signal;
    signalChildGroup(signal);
  }]));
  for (const [signal, handler] of handlers) signalSource.on(signal, handler);
  return Object.freeze({
    attach(value) {
      child = value;
      if (requestedSignal !== null) signalChildGroup(requestedSignal);
    },
    detach(value) {
      if (child === value) child = null;
    },
    requestedSignal() {
      return requestedSignal;
    },
    close() {
      for (const [signal, handler] of handlers) signalSource.off(signal, handler);
    },
  });
}

function sameEntryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function removePathEntry(path) {
  const stats = optionalStats(path);
  if (stats !== null) rmSync(path, { recursive: stats.isDirectory(), force: false });
}

function requireQuarantinePathsAbsent(activeConfig) {
  if (optionalStats(activeConfig.maskPath) !== null || optionalStats(activeConfig.replacementPath) !== null) {
    throw new Error('active OpenWrt config quarantine paths are not empty');
  }
}

function createExactActiveConfig(path) {
  removePathEntry(path);
  symlinkSync(ACTIVE_CONFIG_TARGET, path);
  assertExactActiveConfigLink(path);
}

async function waitForUpdateFeedsChild(spawnChild, activeConfig, signalForwarder) {
  let child;
  try {
    child = spawnChild(UPDATE_FEEDS_PATH, UPDATE_FEEDS_ARGV, {
      cwd: activeConfig.directoryPath,
      detached: true,
      env: { ...process.env, TOPDIR: UPDATE_FEEDS_TOPDIR },
      shell: false,
      stdio: ['inherit', 'inherit', 'inherit', activeConfig.directory],
    });
  } catch (error) {
    return { status: null, signal: null, error };
  }
  if (!child || typeof child.once !== 'function') return child;
  signalForwarder.attach(child);
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      signalForwarder.detach(child);
      resolve(result);
    };
    child.once('error', (error) => finish({ status: null, signal: null, error }));
    child.once('close', (status, signal) => finish({ status, signal }));
  });
}

async function restoreActiveConfig(activeConfig, original, hooks) {
  const anomalies = [];
  const recordFailure = (message, error) => {
    anomalies.push(error instanceof Error ? new Error(message, { cause: error }) : new Error(message));
  };
  const exactOriginalMask = () => {
    try {
      const masked = optionalStats(activeConfig.maskPath);
      return masked !== null
        && sameEntryIdentity(original, masked)
        && masked.isSymbolicLink()
        && readlinkSync(activeConfig.maskPath) === ACTIVE_CONFIG_TARGET;
    } catch {
      return false;
    }
  };
  const activeBefore = optionalStats(activeConfig.path);
  if (activeBefore !== null) {
    anomalies.push(new Error('active OpenWrt config link changed while feeds were running'));
    try {
      await step(hooks, 'before-config-replacement-quarantine', activeConfig.path);
      removePathEntry(activeConfig.replacementPath);
      renameSync(activeConfig.path, activeConfig.replacementPath);
      const replacement = lstatSync(activeConfig.replacementPath);
      if (!sameEntryIdentity(activeBefore, replacement)) {
        anomalies.push(new Error('active OpenWrt config replacement changed while being quarantined'));
      }
    } catch (error) {
      recordFailure('active OpenWrt config replacement could not be quarantined', error);
      try { removePathEntry(activeConfig.path); }
      catch (cleanupError) { recordFailure('active OpenWrt config replacement could not be removed', cleanupError); }
    }
  }

  let restoredOriginal = false;
  if (exactOriginalMask()) {
    try { await step(hooks, 'before-config-restore-rename', activeConfig.maskPath); }
    catch (error) { recordFailure('active OpenWrt config restoration hook failed', error); }
    if (exactOriginalMask()) {
      try {
        removePathEntry(activeConfig.path);
        renameSync(activeConfig.maskPath, activeConfig.path);
        restoredOriginal = true;
        await step(hooks, 'after-config-restore-rename', activeConfig.path);
      } catch (error) {
        recordFailure('active OpenWrt config changed during restoration', error);
      }
    } else {
      anomalies.push(new Error('quarantined active OpenWrt config changed before restoration'));
    }
  } else {
    anomalies.push(new Error('quarantined active OpenWrt config changed before restoration'));
  }

  try {
    assertExactActiveConfigLink(activeConfig.path);
  } catch (error) {
    recordFailure(restoredOriginal ? 'restored active OpenWrt config failed final attestation' : 'active OpenWrt config required exact-link recovery', error);
    try {
      removePathEntry(activeConfig.maskPath);
      createExactActiveConfig(activeConfig.path);
    } catch (recoveryError) {
      recordFailure('active OpenWrt config exact-link recovery failed', recoveryError);
    }
  }

  for (const [path, field] of [
    [activeConfig.maskPath, 'mask'],
    [activeConfig.replacementPath, 'replacement'],
  ]) {
    try { removePathEntry(path); }
    catch (error) { recordFailure(`active OpenWrt config ${field} cleanup failed`, error); }
  }
  try { assertExactActiveConfigLink(activeConfig.path); }
  catch (error) { recordFailure('active OpenWrt config final postcondition failed', error); }

  if (anomalies.length === 1) throw anomalies[0];
  if (anomalies.length > 1) throw new AggregateError(anomalies, 'active OpenWrt config restoration encountered anomalies');
}

async function updateFeeds(root, spawnChild = spawn, hooks = {}, signalSource = process) {
  requireAbsoluteRoot(root);
  const activeConfig = openActiveConfigDirectory(root);
  const signalForwarder = createSignalForwarder(signalSource);
  let original;
  let maskRenamed = false;
  let operationError;
  let restorationError;
  try {
    try {
      requireQuarantinePathsAbsent(activeConfig);
      assertExactActiveConfigLink(activeConfig.path);
      if (signalForwarder.requestedSignal() !== null) {
        throw new OperationExitError(signalExitCode(signalForwarder.requestedSignal()), `trusted feeds update terminated by ${signalForwarder.requestedSignal()}`, true);
      }
      original = lstatSync(activeConfig.path);
      await step(hooks, 'before-config-mask-rename', activeConfig.path);
      if (signalForwarder.requestedSignal() !== null) {
        throw new OperationExitError(signalExitCode(signalForwarder.requestedSignal()), `trusted feeds update terminated by ${signalForwarder.requestedSignal()}`, true);
      }
      renameSync(activeConfig.path, activeConfig.maskPath);
      maskRenamed = true;
      const masked = lstatSync(activeConfig.maskPath);
      if (
        !sameEntryIdentity(original, masked)
        || !masked.isSymbolicLink()
        || readlinkSync(activeConfig.maskPath) !== ACTIVE_CONFIG_TARGET
      ) throw new Error('active OpenWrt config changed during mask rename');
      await step(hooks, 'after-config-mask-rename', activeConfig.maskPath);
      if (optionalStats(activeConfig.path) !== null) throw new Error('active OpenWrt config changed after masking');
      if (signalForwarder.requestedSignal() !== null) {
        throw new OperationExitError(signalExitCode(signalForwarder.requestedSignal()), `trusted feeds update terminated by ${signalForwarder.requestedSignal()}`, true);
      }
      const child = await waitForUpdateFeedsChild(spawnChild, activeConfig, signalForwarder);
      if (child.error) throw new OperationExitError(127, `trusted feeds update failed to spawn: ${child.error.message}`, true);
      if (signalForwarder.requestedSignal() !== null) throw new OperationExitError(signalExitCode(signalForwarder.requestedSignal()), `trusted feeds update terminated by ${signalForwarder.requestedSignal()}`, true);
      if (child.signal !== null) throw new OperationExitError(signalExitCode(child.signal), `trusted feeds update terminated by ${child.signal}`, true);
      if (child.status !== 0) throw new OperationExitError(child.status ?? 1, `trusted feeds update exited with ${child.status ?? 1}`);
    } catch (error) {
      operationError = error;
    }
  } finally {
    if (maskRenamed) {
      try { await restoreActiveConfig(activeConfig, original, hooks); }
      catch (error) { restorationError = error; }
    } else if (original !== undefined) {
      try {
        const current = optionalStats(activeConfig.path);
        if (
          current === null
          || !current.isSymbolicLink()
          || readlinkSync(activeConfig.path) !== ACTIVE_CONFIG_TARGET
        ) {
          createExactActiveConfig(activeConfig.path);
          restorationError = new Error('active OpenWrt config changed before masking');
        }
      } catch (error) { restorationError = error; }
    }
    if (original !== undefined) {
      for (const [path, field] of [
        [activeConfig.maskPath, 'mask'],
        [activeConfig.replacementPath, 'replacement'],
      ]) {
        try { removePathEntry(path); }
        catch (error) {
          const cleanupError = new Error(`active OpenWrt config ${field} finalizer cleanup failed`, { cause: error });
          restorationError = restorationError === undefined
            ? cleanupError
            : new AggregateError([restorationError, cleanupError], 'active OpenWrt config finalizer cleanup failed');
        }
      }
      try { assertExactActiveConfigLink(activeConfig.path); }
      catch (error) {
        const postconditionError = new Error('active OpenWrt config outer finalizer postcondition failed', { cause: error });
        restorationError = restorationError === undefined
          ? postconditionError
          : new AggregateError([restorationError, postconditionError], 'active OpenWrt config finalizer postcondition failed');
      }
    }
    try { assertNamedOpenWrtDirectory(activeConfig); }
    catch (error) {
      restorationError = restorationError === undefined
        ? error
        : new AggregateError([restorationError, error], 'active OpenWrt config and directory restoration failed');
    }
    try { closeSync(activeConfig.directory); }
    finally { signalForwarder.close(); }
  }
  if (operationError === undefined && signalForwarder.requestedSignal() !== null) {
    operationError = new OperationExitError(signalExitCode(signalForwarder.requestedSignal()), `trusted feeds update terminated by ${signalForwarder.requestedSignal()}`, true);
  }
  if (restorationError !== undefined) {
    if (operationError !== undefined) throw new AggregateError([operationError, restorationError], 'feeds update failed and active OpenWrt config restoration failed');
    throw restorationError;
  }
  if (operationError !== undefined) throw operationError;
  return { operation: 'update-feeds' };
}

function requireAbsoluteRoot(root) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0')) throw new Error('operation root is not a canonical absolute path');
}

function runModuleProbe(nodeRed, dependencies, spawn = spawnSync) {
  requireAbsoluteRoot(nodeRed);
  requireAbsoluteRoot(dependencies.nodeBinary);
  requireAbsoluteRoot(dependencies.probeProgram);
  const results = [];
  for (let packageIndex = 0; packageIndex < NODE_MODULES.length; packageIndex += 1) {
    const [packageName, specifier] = NODE_MODULES[packageIndex];
    const args = [
      '--experimental-vm-modules',
      '--permission',
      `--allow-fs-read=${dependencies.probeProgram}`,
      `--allow-fs-read=${nodeRed}`,
      dependencies.probeProgram,
      '--rootfs-node-red',
      nodeRed,
      '--package-index',
      String(packageIndex),
    ];
    const execution = spawn(dependencies.nodeBinary, args, {
      cwd: '/',
      encoding: 'utf8',
      env: {
        HOME: '/nonexistent',
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        TZ: 'UTC',
      },
      timeout: MODULE_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    if (execution.error) {
      const suffix = execution.error.code === 'ETIMEDOUT' ? ' timed out' : '';
      throw new Error(`rootfs Node module permission probe${suffix} could not start`, {
        cause: execution.error,
      });
    }
    if (execution.status !== 0 || execution.signal !== null) {
      const stderr = execution.stderr.trim();
      throw new Error(
        `rootfs Node module permission probe failed for ${packageName}${
          stderr.length > 0 ? `: ${stderr.slice(0, 4096)}` : ''
        }`,
      );
    }
    const stdout = execution.stdout;
    if (
      stdout.length > 1024 * 1024
      || stdout.includes('\r')
      || !stdout.endsWith('\n')
      || stdout.indexOf('\n') !== stdout.length - 1
    ) {
      throw new Error('rootfs Node module permission probe output is not one record');
    }
    const text = stdout.slice(0, -1);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error('rootfs Node module permission probe output is not JSON', {
        cause: error,
      });
    }
    if (
      parsed === null
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || JSON.stringify(parsed) !== text
      || Object.keys(parsed).join('\0')
        !== 'packageIndex\0packageName\0specifier\0resolvedRelativePath\0exportType'
      || parsed.packageIndex !== packageIndex
      || parsed.packageName !== packageName
      || parsed.specifier !== specifier
      || typeof parsed.resolvedRelativePath !== 'string'
      || parsed.resolvedRelativePath.length === 0
      || parsed.resolvedRelativePath.startsWith('/')
      || parsed.resolvedRelativePath.split('/').includes('..')
      || !['function', 'object', 'incompatible'].includes(parsed.exportType)
    ) {
      throw new Error('rootfs Node module permission probe binding changed');
    }
    const expectedRoot = specifier.startsWith('./')
      ? `${packageName}/`
      : `node_modules/${packageName}/`;
    if (!parsed.resolvedRelativePath.startsWith(expectedRoot)) {
      throw new Error(`resolved Node module changed package identity: ${packageName}`);
    }
    const { packageIndex: _packageIndex, ...result } = parsed;
    results.push(result);
  }
  return results;
}

export function runModuleProbeForTesting(nodeRed, dependencies, spawn = spawnSync) {
  return runModuleProbe(nodeRed, dependencies, spawn);
}

function entryPath(directory, name = '') {
  return name.length === 0 ? `${PROC_FD}/${directory.fd}` : `${PROC_FD}/${directory.fd}/${name}`;
}

async function step(hooks, point, path) {
  await hooks?.onStep?.(point, path);
}

async function openRoot(root) {
  return open(root, DIRECTORY_FLAGS);
}

async function openDirectoryAt(parent, name, field, hooks) {
  const path = entryPath(parent, name);
  await step(hooks, 'before-directory-open', path);
  try { return await open(path, DIRECTORY_FLAGS); }
  catch (error) { if (error?.code === 'ELOOP') throw new Error(`${field} contains a symbolic link`, { cause: error });
    throw new Error(`${field} is not a stable directory or symbolic link`, { cause: error }); }
}

async function openFileAt(parent, name, field, hooks) {
  const path = entryPath(parent, name);
  await step(hooks, 'before-file-open', path);
  try { return await open(path, FILE_FLAGS); }
  catch (error) { if (error?.code === 'ELOOP') throw new Error(`${field} contains a symbolic link`, { cause: error });
    throw new Error(`${field} is not a stable regular file or symbolic link`, { cause: error }); }
}

async function openDirectoryChain(parent, relativePath, create, field, hooks) {
  const handles = [];
  let current = parent;
  try {
    for (const name of relativePath.split('/').filter(Boolean)) {
      let child;
      try { child = await openDirectoryAt(current, name, field, hooks); }
      catch (error) {
        if (!create || error?.cause?.code !== 'ENOENT') throw error;
        await step(hooks, 'before-directory-create', entryPath(current, name));
        await mkdir(entryPath(current, name));
        child = await openDirectoryAt(current, name, field, hooks);
      }
      handles.push(child);
      current = child;
    }
    return { handle: current, handles };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close();
    throw error;
  }
}

async function closeChain(chain) {
  for (const handle of [...chain.handles].reverse()) await handle.close();
}

async function hashHandle(handle) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
  }
  return hash.digest('hex');
}

async function readHandle(handle) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks);
}

function deriveFeedConfig(source) {
  if (typeof source !== 'string') {
    throw new Error('feed configuration does not contain exactly one supported ChirpStack src-link');
  }
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom.length === 0 ? source : source.slice(1);
  let chirpstackEntries = 0;
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/u);
    if (parts[1] !== 'chirpstack') continue;
    chirpstackEntries += 1;
    if (line !== CANONICAL_CHIRPSTACK_SOURCE) {
      throw new Error('feed configuration does not contain exactly one supported ChirpStack src-link');
    }
  }
  if (chirpstackEntries !== 1) {
    throw new Error('feed configuration does not contain exactly one supported ChirpStack src-link');
  }
  let matches = 0;
  const derived = body.replace(
    /^([ \t]*)src-link chirpstack feeds\/chirpstack-openwrt-feed([ \t]*)(\r?)$/gmu,
    (_line, leading, trailing, carriageReturn) => {
      matches += 1;
      return `${leading}${CANONICAL_CHIRPSTACK_DESTINATION}${trailing}${carriageReturn}`;
    },
  );
  if (matches !== 1) throw new Error('feed configuration does not contain exactly one supported ChirpStack src-link');
  return `${bom}${derived}`;
}

async function writeFileAt(parent, name, contents, field, hooks) {
  await step(hooks, 'before-destination-create', entryPath(parent, name));
  const destination = await open(entryPath(parent, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    let position = 0;
    while (position < contents.length) {
      const result = await destination.write(contents, position, contents.length - position, position);
      if (result.bytesWritten === 0) throw new Error(`${field} destination did not accept bytes`);
      position += result.bytesWritten;
    }
    await destination.sync();
  } finally { await destination.close(); }
}

async function hashFileAt(parent, name, field, hooks) {
  const handle = await openFileAt(parent, name, field, hooks);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${field} is not a regular file`);
    return { size: info.size, sha256: await hashHandle(handle) };
  } finally { await handle.close(); }
}

async function copyFileAt(sourceParent, sourceName, destinationParent, destinationName, field, hooks) {
  const source = await openFileAt(sourceParent, sourceName, `${field} source`, hooks);
  try {
    const sourceInfo = await source.stat();
    if (!sourceInfo.isFile()) throw new Error(`${field} source is not a regular file`);
    await step(hooks, 'before-destination-create', entryPath(destinationParent, destinationName));
    const destination = await open(entryPath(destinationParent, destinationName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let position = 0;
      while (position < sourceInfo.size) {
        const length = Math.min(buffer.length, sourceInfo.size - position);
        const result = await source.read(buffer, 0, length, position);
        if (result.bytesRead === 0) throw new Error(`${field} source ended during copy`);
        await destination.write(buffer, 0, result.bytesRead);
        position += result.bytesRead;
      }
    } finally { await destination.close(); }
  } finally { await source.close(); }
}

async function fileManifest(directory, relativePath = '', hooks) {
  const result = new Map();
  for (const entry of (await readdir(entryPath(directory), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const currentPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`source contains a symbolic link at ${currentPath}`);
    if (entry.isDirectory()) {
      const child = await openDirectoryAt(directory, entry.name, `source directory ${currentPath}`, hooks);
      try {
        for (const [file, metadata] of await fileManifest(child, currentPath, hooks)) result.set(file, metadata);
      } finally { await child.close(); }
    } else if (entry.isFile()) {
      const metadata = await hashFileAt(directory, entry.name, `source file ${currentPath}`, hooks);
      result.set(currentPath, metadata);
    } else {
      throw new Error(`source contains a non-regular path at ${currentPath}`);
    }
  }
  return result;
}

function manifestHash(manifest) {
  const serialized = [...manifest.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => `${path}\0${value.size}\0${value.sha256}\n`).join('');
  return createHash('sha256').update(serialized).digest('hex');
}

function equalManifest(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, value] of left) {
    const other = right.get(path);
    if (!other || other.size !== value.size || other.sha256 !== value.sha256) return false;
  }
  return true;
}

async function copyManifest(source, destination, manifest, hooks) {
  for (const path of [...manifest.keys()].sort()) {
    const parts = path.split('/');
    const file = parts.pop();
    const sourceChain = await openDirectoryChain(source, parts.join('/'), false, `source ${path}`, hooks);
    try {
      const destinationChain = await openDirectoryChain(destination, parts.join('/'), true, `destination ${path}`, hooks);
      try { await copyFileAt(sourceChain.handle, file, destinationChain.handle, file, path, hooks); }
      finally { await closeChain(destinationChain); }
    } finally { await closeChain(sourceChain); }
  }
}

async function removeEntry(parent, name, hooks) {
  const path = entryPath(parent, name);
  let value;
  try { value = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  await step(hooks, 'before-remove', path);
  if (value.isSymbolicLink()) throw new Error(`cannot remove symbolic link: ${path}`);
  if (value.isFile()) { await unlink(path); return; }
  if (!value.isDirectory()) throw new Error(`cannot remove non-regular path ${path}`);
  const child = await openDirectoryAt(parent, name, 'removal directory', hooks);
  const identity = await child.stat();
  try {
    for (const entry of await readdir(entryPath(child), { withFileTypes: true })) await removeEntry(child, entry.name, hooks);
    const current = await lstat(path);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error(`directory changed during removal: ${path}`);
    await step(hooks, 'before-remove-directory', path);
    const stable = await lstat(path);
    if (!stable.isDirectory() || stable.dev !== identity.dev || stable.ino !== identity.ino) throw new Error(`directory changed before removal: ${path}`);
    await rmdir(path);
  } finally { await child.close(); }
}

async function removeUntrustedEntry(parent, name) {
  const path = entryPath(parent, name);
  let value;
  try { value = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (value.isSymbolicLink() || value.isFile()) { await unlink(path); return; }
  if (!value.isDirectory()) throw new Error(`cannot quarantine non-regular path ${path}`);
  for (let index = 0; index < 100; index += 1) {
    const quarantine = `${name}.quarantine${index === 0 ? '' : `-${index}`}`;
    try { await lstat(entryPath(parent, quarantine)); continue; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { await rename(path, entryPath(parent, quarantine)); return; }
      catch (renameError) {
        if (renameError?.code === 'ENOENT') return;
        if (renameError?.code !== 'EEXIST') throw renameError;
      }
    }
  }
  throw new Error(`could not quarantine untrusted path ${path}`);
}

async function replaceExactSymlink(parent, name, target, field, hooks) {
  const path = entryPath(parent, name);
  try {
    await lstat(path);
    throw new Error(`${field} already exists; fresh workspaces must not contain active target links`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await step(hooks, 'before-symlink', path);
  try { await symlink(target, path); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${field} changed before symlink creation`, { cause: error });
    throw error;
  }
  const created = await lstat(path);
  if (!created.isSymbolicLink() || await readlink(path) !== target) {
    throw new Error(`${field} did not resolve to the exact selected profile`);
  }
  await step(hooks, 'before-symlink-attestation', path);
  const selected = await lstat(path);
  if (
    !selected.isSymbolicLink()
    || selected.dev !== created.dev
    || selected.ino !== created.ino
    || await readlink(path) !== target
  ) throw new Error(`${field} changed before final selected-profile attestation`);
}

async function activateTarget(root, environment, hooks) {
  if (!TARGET_ENVIRONMENTS.has(environment)) throw new Error('target environment is not a trusted Raspberry Pi profile');
  const rootHandle = await openRoot(root);
  let conf;
  let openwrt;
  let profile;
  try {
    conf = await openDirectoryChain(rootHandle, 'conf', false, 'configuration directory', hooks);
    openwrt = await openDirectoryChain(rootHandle, 'openwrt', false, 'OpenWrt directory', hooks);
    profile = await openDirectoryChain(rootHandle, `conf/${environment}`, false, 'target profile', hooks);
    const config = await openFileAt(profile.handle, '.config', 'target profile .config', hooks);
    await config.close();
    for (const name of ['files', 'patches']) {
      const child = await openDirectoryChain(profile.handle, name, false, `target profile ${name}`, hooks);
      await closeChain(child);
    }
    for (const [parentName, name, targetFactory] of TARGET_LINKS) {
      const parent = parentName === 'conf' ? conf.handle : openwrt.handle;
      await replaceExactSymlink(parent, name, targetFactory(environment), `${parentName}/${name}`, hooks);
    }
    return { operation: 'activate-target', environment };
  } finally {
    if (profile) await closeChain(profile);
    if (openwrt) await closeChain(openwrt);
    if (conf) await closeChain(conf);
    await rootHandle.close();
  }
}

function sameIdentity(named, held, kind) {
  return named.dev === held.dev && named.ino === held.ino && (kind === 'directory' ? named.isDirectory() : named.isFile());
}

async function assertNamedIdentity(parent, name, held, kind, field) {
  const named = await lstat(entryPath(parent, name));
  const heldInfo = await held.stat();
  if (!sameIdentity(named, heldInfo, kind)) throw new Error(`${field} identity changed before publication`);
}

async function inspectExactSymlink(parent, name, target, field) {
  const path = entryPath(parent, name);
  let info;
  try { info = await lstat(path); }
  catch (error) { throw new Error(`${field} is missing or cannot be inspected`, { cause: error }); }
  let observedTarget;
  try { observedTarget = await readlink(path); }
  catch (error) { throw new Error(`${field} is not a readable symbolic link`, { cause: error }); }
  if (!info.isSymbolicLink() || observedTarget !== target) {
    throw new Error(`${field} is not the exact ${target} symbolic link`);
  }
  return info;
}

async function assertExactSymlinkIdentity(parent, name, target, expected, field) {
  const current = await inspectExactSymlink(parent, name, target, field);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`${field} changed while resolving the active target`);
  }
}

async function readActiveTargetConfig(rootHandle, hooks) {
  let conf;
  let openwrt;
  let profile;
  let config;
  try {
    conf = await openDirectoryChain(rootHandle, 'conf', false, 'configuration directory', hooks);
    openwrt = await openDirectoryChain(rootHandle, 'openwrt', false, 'OpenWrt directory', hooks);
    const openwrtLink = await inspectExactSymlink(
      openwrt.handle,
      '.config',
      ACTIVE_CONFIG_TARGET,
      'active OpenWrt config',
    );
    const confPath = entryPath(conf.handle, '.config');
    let confInfo;
    try { confInfo = await lstat(confPath); }
    catch (error) { throw new Error('active profile config is missing or cannot be inspected', { cause: error }); }
    let confTarget;
    try { confTarget = await readlink(confPath); }
    catch (error) { throw new Error('active profile config is not a readable symbolic link', { cause: error }); }
    const environment = [...TARGET_ENVIRONMENTS].find(
      (candidate) => confTarget === `${candidate}/.config`,
    );
    if (!confInfo.isSymbolicLink() || environment === undefined) {
      throw new Error('active profile config does not select an exact trusted Raspberry Pi profile');
    }
    profile = await openDirectoryAt(conf.handle, environment, 'active target profile', hooks);
    config = await openFileAt(profile, '.config', 'active target profile config', hooks);
    const contents = await config.readFile('utf8');
    await step(hooks, 'before-active-config-attestation', confPath);
    await assertExactSymlinkIdentity(
      openwrt.handle,
      '.config',
      ACTIVE_CONFIG_TARGET,
      openwrtLink,
      'active OpenWrt config',
    );
    await assertExactSymlinkIdentity(
      conf.handle,
      '.config',
      `${environment}/.config`,
      confInfo,
      'active profile config',
    );
    return contents;
  } finally {
    if (config) await config.close();
    if (profile) await profile.close();
    if (openwrt) await closeChain(openwrt);
    if (conf) await closeChain(conf);
  }
}

async function publishVerified(sourceParent, sourceName, sourceHandle, destinationParent, destinationName, kind, field, hooks, verify) {
  await assertNamedIdentity(sourceParent, sourceName, sourceHandle, kind, field);
  await step(hooks, 'before-rename', entryPath(sourceParent, sourceName));
  await assertNamedIdentity(sourceParent, sourceName, sourceHandle, kind, field);
  let renamed = false;
  try {
    await rename(entryPath(sourceParent, sourceName), entryPath(destinationParent, destinationName));
    renamed = true;
    await step(hooks, 'after-rename', entryPath(destinationParent, destinationName));
    const destination = kind === 'directory'
      ? await openDirectoryAt(destinationParent, destinationName, `${field} destination`, hooks)
      : await openFileAt(destinationParent, destinationName, `${field} destination`, hooks);
    try {
      const publishedInfo = await destination.stat();
      const sourceInfo = await sourceHandle.stat();
      if (!sameIdentity(publishedInfo, sourceInfo, kind)) throw new Error(`${field} destination identity does not match verified staging`);
      const result = await verify(destination);
      await assertNamedIdentity(destinationParent, destinationName, destination, kind, field);
      return result;
    } finally { await destination.close(); }
  } catch (error) {
    if (renamed) {
      try { await removeUntrustedEntry(destinationParent, destinationName); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `${field} publication failed and untrusted destination cleanup failed`); }
    }
    throw error;
  }
}

async function copyFeedConfig(root, hooks) {
  const rootHandle = await openRoot(root);
  let openwrt;
  let sourceHandle;
  try {
    openwrt = await openDirectoryChain(rootHandle, 'openwrt', true, 'OpenWrt directory', hooks);
    sourceHandle = await openFileAt(rootHandle, FIXED_PATHS.feedSource, 'feed configuration source', hooks);
    const sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile()) throw new Error('feed configuration source is not a regular file');
    const sourceContents = await readHandle(sourceHandle);
    if (sourceContents.length !== sourceInfo.size) throw new Error('feed configuration source changed while reading');
    await assertNamedIdentity(rootHandle, FIXED_PATHS.feedSource, sourceHandle, 'file', 'feed configuration source');
    let sourceText;
    try {
      sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sourceContents);
    } catch (error) {
      throw new Error('feed configuration source is not valid UTF-8', { cause: error });
    }
    const destinationContents = Buffer.from(deriveFeedConfig(sourceText));
    const source = { size: sourceContents.length, sha256: createHash('sha256').update(sourceContents).digest('hex') };
    const expectedDestination = { size: destinationContents.length, sha256: createHash('sha256').update(destinationContents).digest('hex') };
    await removeUntrustedEntry(rootHandle, FIXED_PATHS.feedStaging);
    await writeFileAt(rootHandle, FIXED_PATHS.feedStaging, destinationContents, 'feed configuration', hooks);
    const staging = await openFileAt(rootHandle, FIXED_PATHS.feedStaging, 'feed configuration staging', hooks);
    try {
      const stagingInfo = await staging.stat();
      const staged = { size: stagingInfo.size, sha256: await hashHandle(staging) };
      if (expectedDestination.sha256 !== staged.sha256 || expectedDestination.size !== staged.size) throw new Error('derived feed configuration changed during staging');
      await removeEntry(openwrt.handle, 'feeds.conf.default', hooks);
      await publishVerified(rootHandle, FIXED_PATHS.feedStaging, staging, openwrt.handle, 'feeds.conf.default', 'file', 'feed configuration', hooks, async (destination) => {
        const destinationInfo = await destination.stat();
        const destinationHash = await hashHandle(destination);
        if (expectedDestination.sha256 !== destinationHash || expectedDestination.size !== destinationInfo.size) throw new Error('derived feed configuration changed during publication');
      });
    } finally { await staging.close(); }
    return { operation: 'copy-feed-config', source: FIXED_PATHS.feedSource, destination: FIXED_PATHS.feedDestination, sha256: source.sha256, sourceSha256: source.sha256, destinationSha256: expectedDestination.sha256 };
  } finally { if (sourceHandle) await sourceHandle.close(); if (openwrt) await closeChain(openwrt); await rootHandle.close(); }
}

async function mirrorGui(root, hooks) {
  const rootHandle = await openRoot(root);
  let source;
  let destinationParent;
  try {
    source = await openDirectoryChain(rootHandle, FIXED_PATHS.guiSource, false, 'GUI source', hooks);
    destinationParent = await openDirectoryChain(rootHandle, 'feeds/chirpstack-openwrt-feed/apps/node-red/files', true, 'GUI destination parent', hooks);
    const sourceManifest = await fileManifest(source.handle, '', hooks);
    if (sourceManifest.size === 0) throw new Error('GUI build output contains no regular files');
    await removeUntrustedEntry(rootHandle, FIXED_PATHS.guiStaging);
    await mkdir(entryPath(rootHandle, FIXED_PATHS.guiStaging));
    const staging = await openDirectoryAt(rootHandle, FIXED_PATHS.guiStaging, 'GUI staging', hooks);
    try {
      await copyManifest(source.handle, staging, sourceManifest, hooks);
      const stagedManifest = await fileManifest(staging, '', hooks);
      if (!equalManifest(sourceManifest, stagedManifest)) throw new Error('GUI staging manifest does not match source');
      await removeEntry(destinationParent.handle, 'gui', hooks);
      await publishVerified(rootHandle, FIXED_PATHS.guiStaging, staging, destinationParent.handle, 'gui', 'directory', 'GUI staging', hooks, async (destination) => {
        const destinationManifest = await fileManifest(destination, '', hooks);
        if (!equalManifest(sourceManifest, destinationManifest)) throw new Error('GUI destination manifest does not match source');
      });
    } finally { await staging.close(); }
    return { operation: 'mirror-gui', source: FIXED_PATHS.guiSource, destination: FIXED_PATHS.guiDestination, fileCount: sourceManifest.size, manifestSha256: manifestHash(sourceManifest) };
  } finally { if (destinationParent) await closeChain(destinationParent); if (source) await closeChain(source); await rootHandle.close(); }
}

async function verifyImage(root, hooks, probeDependencies) {
  const rootHandle = await openRoot(root);
  let profile;
  try {
    const contents = await readActiveTargetConfig(rootHandle, hooks);
    let rootfs;
    const profiles = Object.entries(ROOTFS_BY_PROFILE).filter(
      ([profileName]) => contents.includes(`CONFIG_TARGET_PROFILE="${profileName}"`),
    );
    if (profiles.length !== 1) throw new Error('active target profile is not an exact trusted Node resolution target');
    rootfs = profiles[0][1];

    profile = await openDirectoryChain(
      rootHandle,
      `${FIXED_PATHS.imageDirectory}/${rootfs.imageDirectory}`,
      false,
      'firmware image profile',
      hooks,
    );
    const candidates = [];
    for (const file of await readdir(entryPath(profile.handle), { withFileTypes: true })) {
      const matchesFactory = file.name.startsWith(rootfs.imagePrefix)
        && file.name.endsWith(rootfs.imageSuffix)
        && file.name.length > rootfs.imagePrefix.length + rootfs.imageSuffix.length;
      if (file.isSymbolicLink()) throw new Error(`image artifact contains a symbolic link: ${file.name}`);
      if (matchesFactory && !file.isFile()) throw new Error(`factory image artifact is not a regular file: ${file.name}`);
      if (matchesFactory) candidates.push(file.name);
    }
    if (candidates.length !== 1) throw new Error(`expected exactly one firmware image, found ${candidates.length}`);
    const candidate = candidates[0];
    try {
      const image = await openFileAt(profile.handle, candidate, 'firmware image', hooks);
      try {
        const info = await image.stat();
        if (!info.isFile() || info.size < 64 * 1024 * 1024) throw new Error('firmware image is missing or below the 64 MiB minimum');
        const nodeRed = `${root}/${rootfs.path}/usr/share/node-red`;
        const nodeResolution = runModuleProbe(nodeRed, probeDependencies);
        return {
          operation: 'verify-image',
          targetId: rootfs.targetId,
          relativePath: `${FIXED_PATHS.imageDirectory}/${rootfs.imageDirectory}/${candidate}`,
          size: info.size,
          sha256: await hashHandle(image),
          nodeResolution,
        };
      } finally { await image.close(); }
    } finally { await closeChain(profile); profile = undefined; }
  } finally { if (profile) await closeChain(profile); await rootHandle.close(); }
}

export function createOperationHandlersForTesting(
  root,
  hooks = {},
  probeDependencies = TEST_PROBE_DEPENDENCIES,
) {
  requireAbsoluteRoot(root);
  return Object.freeze({
    activateTarget: (environment) => activateTarget(root, environment, hooks),
    copyFeedConfig: () => copyFeedConfig(root, hooks),
    updateFeeds: () => updateFeeds(root),
    mirrorGui: () => mirrorGui(root, hooks),
    verifyImage: () => verifyImage(root, hooks, probeDependencies),
  });
}

export async function runUpdateFeedsForTesting(root, spawn = spawnSync, hooks = {}, signalSource = process) {
  return updateFeeds(root, spawn, hooks, signalSource);
}

async function main() {
  const args = process.argv.slice(2);
  if (
    (args.length !== 1 && args.length !== 2)
    || !OPERATIONS.has(args[0])
    || (args[0] === 'activate-target' && (args.length !== 2 || !TARGET_ENVIRONMENTS.has(args[1])))
    || (args[0] !== 'activate-target' && args.length !== 1)
  ) { fail('operation arguments are not the exact trusted contract'); return; }
  try {
    const handlers = createOperationHandlersForTesting(
      WORKTREE,
      {},
      INSTALLED_PROBE_DEPENDENCIES,
    );
    const result = args[0] === 'activate-target'
      ? await handlers.activateTarget(args[1])
      : args[0] === 'copy-feed-config'
        ? await handlers.copyFeedConfig()
        : args[0] === 'update-feeds'
          ? await handlers.updateFeeds()
        : args[0] === 'mirror-gui'
          ? await handlers.mirrorGui()
          : await handlers.verifyImage();
    if (args[0] !== 'update-feeds') process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    if (error instanceof OperationExitError) {
      if (error.report) process.stderr.write(`osi-image-builder-tool: ${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
