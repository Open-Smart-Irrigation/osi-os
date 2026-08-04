#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';

const { authenticatedProxyEnvironment } = createRequire(import.meta.url)('./osi-proxy-credential-environment.cjs');

const WORKTREE = '/workdir';
const TOOL = '/opt/osi-image-builder/operations/osi-image-builder-tool.js';
const PROXY_CREDENTIAL_PATH = '/run/osi-image-builder/proxy-credential';
const ENVIRONMENTS = new Set([
  'full_raspberrypi_bcm27xx_bcm2709',
  'full_raspberrypi_bcm27xx_bcm2712',
]);
const WORKING_DIRECTORIES = new Set(['/workdir', '/workdir/web/react-gui']);
const LINK_SPECS = Object.freeze([
  ['conf/.config', (environment) => `${environment}/.config`],
  ['conf/files', (environment) => `${environment}/files`],
  ['conf/patches', (environment) => `${environment}/patches`],
  ['openwrt/.config', () => '../conf/.config'],
  ['openwrt/files', () => '../conf/files'],
  ['openwrt/patches', () => '../conf/patches'],
]);
const FORWARDED_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);

function fail(message) {
  process.stderr.write(`execution guard: ${message}\n`);
  process.exitCode = 126;
}

function parseNumber(value, field) {
  if (!/^\d+$/u.test(value)) throw new Error(`${field} is not a decimal identity`);
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error(`${field} is negative`);
  return parsed;
}

function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal];
  return Number.isInteger(signalNumber) && signalNumber > 0 && signalNumber < 128 ? 128 + signalNumber : 255;
}

function parseArguments(args) {
  const required = [
    '--workspace-dev=',
    '--workspace-ino=',
    '--active-target-environment=',
    '--operation-id=',
    '--operation-environment=',
    '--working-directory=',
  ];
  if (args.length < required.length + 2) throw new Error('guard arguments are incomplete');
  const values = {};
  let index = 0;
  for (const prefix of required) {
    const argument = args[index++];
    if (!argument.startsWith(prefix)) throw new Error(`guard argument order changed at ${prefix}`);
    values[prefix.slice(0, -1)] = argument.slice(prefix.length);
  }
  if (args[index++] !== '--') throw new Error('guard operation delimiter is missing');
  const operationArgv = args.slice(index);
  if (operationArgv.length === 0) throw new Error('guard operation argv is empty');
  return {
    workspaceDev: parseNumber(values['--workspace-dev'], 'workspace device'),
    workspaceIno: parseNumber(values['--workspace-ino'], 'workspace inode'),
    activeEnvironment: values['--active-target-environment'],
    operationId: values['--operation-id'],
    operationEnvironment: values['--operation-environment'],
    workingDirectory: values['--working-directory'],
    operationArgv,
  };
}

function expectedOperation(operationId, environment) {
  switch (operationId) {
    case 'activate-target': return ['node', TOOL, operationId, environment];
    case 'copy-feed-config': return ['node', TOOL, operationId];
    case 'update-feeds': return ['node', TOOL, 'update-feeds'];
    case 'install-feeds': return ['openwrt/scripts/feeds', 'install', '-a'];
    case 'resolve-config': return ['make', '-C', 'openwrt', 'defconfig'];
    case 'build-image': return ['make', '-C', 'openwrt', '-j4'];
    case 'verify-image': return ['node', TOOL, operationId];
    case 'verify-profile-parity': return ['node', 'scripts/verify-profile-parity.js'];
    case 'verify-chameleon': return ['node', 'scripts/verify-chameleon-calibration.js'];
    case 'verify-db-schema': return ['node', 'scripts/verify-db-schema-consistency.js'];
    case 'verify-sync-flow': return ['node', 'scripts/verify-sync-flow.js'];
    case 'verify-strega': return ['node', 'scripts/verify-strega-gen1.js'];
    case 'verify-communication': return ['node', 'scripts/verify-communication-contract.js'];
    case 'check-mqtt-topics': return ['scripts/check-mqtt-topics.sh'];
    case 'frontend-install': return ['npm', 'ci'];
    case 'frontend-test': return ['npm', 'run', 'test:unit'];
    case 'frontend-typecheck': return ['npm', 'run', 'typecheck'];
    case 'frontend-build': return ['npm', 'run', 'build'];
    case 'mirror-gui': return ['node', TOOL, operationId];
    default: throw new Error('operation ID is not trusted');
  }
}

function assertWorkspace(identity) {
  const stats = lstatSync(WORKTREE, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== identity.workspaceDev || stats.ino !== identity.workspaceIno) {
    throw new Error('mounted workdir identity does not match the held workspace');
  }
}

function assertActiveLinks(environment) {
  if (environment === 'root') return;
  if (!ENVIRONMENTS.has(environment)) throw new Error('active target environment is not trusted');
  for (const [relativePath, expectedTarget] of LINK_SPECS) {
    const path = `${WORKTREE}/${relativePath}`;
    const stats = lstatSync(path, { bigint: true });
    const expected = expectedTarget(environment);
    if (!stats.isSymbolicLink() || readlinkSync(path) !== expected) {
      throw new Error(`active target link ${relativePath} does not match ${environment}`);
    }
  }
}

function readProxyCredential(path) {
  if (path !== PROXY_CREDENTIAL_PATH) throw new Error('proxy credential path differs from the installed policy');
  const stats = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== uid || stats.nlink !== 1 || (stats.mode & 0o777) !== 0o400 || stats.size < 48 || stats.size > 128) {
    throw new Error('proxy credential metadata is unsafe');
  }
  return readFileSync(path, 'utf8');
}

function runTrustedOperation(parsed) {
  let child = null;
  let requestedSignal = null;
  let spawnError = null;
  let settled = false;
  const listeners = new Map();
  const removeSignalListeners = () => {
    for (const [name, listener] of listeners) process.off(name, listener);
  };
  const signalChild = (signal) => {
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The child may have exited between the state check and kill().
    }
  };
  const forwardSignal = (signal) => {
    if (requestedSignal !== null || settled) return;
    requestedSignal = signal;
    process.stderr.write(`execution guard: received ${signal}; forwarding to trusted operation\n`);
    signalChild(signal);
  };
  for (const signal of FORWARDED_SIGNALS) {
    const listener = () => forwardSignal(signal);
    listeners.set(signal, listener);
    process.on(signal, listener);
  }

  try {
    child = spawn(parsed.operationArgv[0], parsed.operationArgv.slice(1), {
      cwd: parsed.workingDirectory,
      detached: true,
      env: authenticatedProxyEnvironment(process.env, readProxyCredential),
      shell: false,
      stdio: 'inherit',
    });
  } catch (error) {
    removeSignalListeners();
    return Promise.resolve({ error });
  }
  if (requestedSignal !== null) signalChild(requestedSignal);

  return new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (status, signal) => {
      settled = true;
      removeSignalListeners();
      resolve({ status, signal, requestedSignal, error: spawnError });
    });
  });
}

async function run() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!ENVIRONMENTS.has(parsed.operationEnvironment)
    || (parsed.activeEnvironment !== 'root' && !ENVIRONMENTS.has(parsed.activeEnvironment))
    || !WORKING_DIRECTORIES.has(parsed.workingDirectory)
    || !/^[a-z0-9-]+$/u.test(parsed.operationId)) {
    throw new Error('guard context is not trusted');
  }
  const expected = expectedOperation(parsed.operationId, parsed.operationEnvironment);
  if (JSON.stringify(parsed.operationArgv) !== JSON.stringify(expected)) throw new Error('operation argv is not the immutable registry argv');
  assertWorkspace(parsed);
  assertActiveLinks(parsed.activeEnvironment);
  if (process.cwd() !== parsed.workingDirectory) throw new Error('container working directory is not the fixed operation directory');
  const child = await runTrustedOperation(parsed);
  if (child.error) {
    process.stderr.write(`execution guard: trusted operation failed to spawn: ${child.error.message}\n`);
    process.exitCode = 127;
    return;
  }
  if (child.requestedSignal !== null) {
    process.stderr.write(`execution guard: trusted operation completed after ${child.requestedSignal}\n`);
    process.exitCode = signalExitCode(child.requestedSignal);
    return;
  }
  if (child.signal !== null) {
    process.stderr.write(`execution guard: trusted operation terminated by ${child.signal}\n`);
    process.exitCode = signalExitCode(child.signal);
    return;
  }
  process.exitCode = child.status ?? 1;
}

run().catch((error) => fail(error instanceof Error ? error.message : String(error)));
