import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { TRUSTED_OPERATION_IDS, type TrustedOperationId } from '../../domain/types.js';

export interface OperationArgvContext {
  readonly environment: string;
  readonly installedToolPath: string;
}

const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

function validateContext(context: OperationArgvContext): void {
  if (!ENVIRONMENT.test(context.environment)) throw new Error('validated manifest environment is invalid');
  if (!ABSOLUTE_PATH.test(context.installedToolPath) || context.installedToolPath.includes('..') || posix.normalize(context.installedToolPath) !== context.installedToolPath) throw new Error('installed operation tool path is not canonical');
}

type OperationFactory = (context: OperationArgvContext) => readonly string[];

const factories: Readonly<Record<TrustedOperationId, OperationFactory>> = Object.freeze({
  'activate-target': (context) => ['make', 'switch-env', `ENV=${context.environment}`],
  'copy-feed-config': (context) => ['node', context.installedToolPath, 'copy-feed-config'],
  'update-feeds': () => ['openwrt/scripts/feeds', 'update', '-a'],
  'install-feeds': () => ['openwrt/scripts/feeds', 'install', '-a'],
  'resolve-config': () => ['make', '-C', 'openwrt', 'defconfig'],
  'build-image': () => ['make', '-C', 'openwrt', '-j4'],
  'verify-image': (context) => ['node', context.installedToolPath, 'verify-image'],
  'verify-profile-parity': () => ['node', 'scripts/verify-profile-parity.js'],
  'verify-chameleon': () => ['node', 'scripts/verify-chameleon-calibration.js'],
  'verify-db-schema': () => ['node', 'scripts/verify-db-schema-consistency.js'],
  'verify-sync-flow': () => ['node', 'scripts/verify-sync-flow.js'],
  'verify-strega': () => ['node', 'scripts/verify-strega-gen1.js'],
  'verify-communication': () => ['node', 'scripts/verify-communication-contract.js'],
  'check-mqtt-topics': () => ['scripts/check-mqtt-topics.sh'],
  'frontend-install': () => ['npm', 'ci'],
  'frontend-test': () => ['npm', 'run', 'test:unit'],
  'frontend-typecheck': () => ['npm', 'run', 'typecheck'],
  'frontend-build': () => ['npm', 'run', 'build'],
  'mirror-gui': (context) => ['node', context.installedToolPath, 'mirror-gui'],
});

export function assertOperationRegistryCoverage(operationIds: readonly string[]): true {
  if (JSON.stringify(operationIds) !== JSON.stringify(TRUSTED_OPERATION_IDS)) throw new Error('operation registry does not exactly cover the locked execution definition');
  for (const operationId of TRUSTED_OPERATION_IDS) if (typeof factories[operationId] !== 'function') throw new Error(`operation registry is missing ${operationId}`);
  return true;
}

export function createOperationArgv(operationId: TrustedOperationId, context: OperationArgvContext): readonly string[] {
  if (!(TRUSTED_OPERATION_IDS as readonly string[]).includes(operationId) || !(operationId in factories)) throw new Error(`unknown operation ID: ${String(operationId)}`);
  validateContext(context);
  const argv = factories[operationId](context);
  if (argv.length === 0 || argv.some((value) => value.length === 0 || /[;&|`$()\n\r]/u.test(value))) throw new Error(`trusted operation ${operationId} produced unsafe argv`);
  return Object.freeze([...argv]);
}

export function hashOperationArgv(argv: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(argv)).digest('hex');
}
