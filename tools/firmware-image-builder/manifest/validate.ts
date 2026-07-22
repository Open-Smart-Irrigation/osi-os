import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { getNodeValue, parseTree, type Node, type ParseError } from 'jsonc-parser';

import {
  PIPELINE_STAGE_NAMES,
  TARGET_IDS,
  isPipelineStageName,
  isTargetId,
  isTrustedOperationId,
  type PipelineStageName,
  type TargetId,
  type TrustedOperationId,
} from '../domain/types.js';
import type {
  ConfigSymbol,
  LoadedManifest,
  Manifest,
  StageDefinition,
  TargetManifest,
} from './schema.js';

export const MANIFEST_ERROR_CODES = Object.freeze([
  'MANIFEST_READ_FAILED',
  'MANIFEST_OPEN_FAILED',
  'MANIFEST_STAT_FAILED',
  'MANIFEST_CLOSE_FAILED',
  'MANIFEST_TOO_LARGE',
  'MANIFEST_FILE_CHANGED',
  'MANIFEST_JSON_INVALID',
  'MANIFEST_ROOT_INVALID',
  'MANIFEST_KEYS_INVALID',
  'DUPLICATE_KEY',
  'SCHEMA_VERSION_INVALID',
  'REPOSITORY_INVALID',
  'REPOSITORY_SHAPE_INVALID',
  'REPOSITORY_KEYS_INVALID',
  'STAGE_ORDER_MISMATCH',
  'UNKNOWN_STAGE',
  'STAGE_DEFINITION_MISMATCH',
  'STAGE_DEFINITION_INVALID',
  'STAGE_DEFINITION_SHAPE_INVALID',
  'STAGE_DEFINITION_KEYS_INVALID',
  'TARGETS_INVALID',
  'TARGET_SHAPE_INVALID',
  'TARGET_KEYS_INVALID',
  'TARGET_ID_INVALID',
  'DUPLICATE_TARGET_ID',
  'TARGET_ORDER_MISMATCH',
  'TARGET_DATA_MISMATCH',
  'UNKNOWN_OPERATION',
  'DUPLICATE_OPERATION',
  'CONFIG_SYMBOL_INVALID',
  'CONFIG_SYMBOL_SHAPE_INVALID',
  'CONFIG_SYMBOL_KEYS_INVALID',
  'CONFIG_SYMBOL_TYPE',
  'CONFIG_SYMBOL_VALUE',
  'MISSING_PROFILE',
  'UNSAFE_PATH',
  'ROOTFS_PART_SIZE',
  'MINIMUM_ARTIFACT_BYTES',
  'ARTIFACT_GLOB_INVALID',
] as const);
export type ManifestErrorCode = (typeof MANIFEST_ERROR_CODES)[number];

export class ManifestValidationError extends Error {
  readonly code: ManifestErrorCode;

  constructor(code: ManifestErrorCode, message: string) {
    super(message);
    this.name = 'ManifestValidationError';
    this.code = code;
  }
}

export interface ManifestFileSystem {
  readonly open: (path: string) => number;
  readonly stat: (fd: number) => { readonly size: number };
  readonly read: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number;
  readonly close: (fd: number) => void;
}

const DEFAULT_MANIFEST_FILE_SYSTEM: ManifestFileSystem = {
  open: (path) => openSync(path, 'r'),
  stat: (fd) => fstatSync(fd),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
};

const STAGE_DEFINITIONS: Readonly<Record<PipelineStageName, StageDefinition>> = Object.freeze({
  preflight: Object.freeze({ required: true, timeoutSeconds: 300 }),
  source: Object.freeze({ required: true, timeoutSeconds: 300 }),
  'release-gates': Object.freeze({ required: true, timeoutSeconds: 1800 }),
  frontend: Object.freeze({ required: true, timeoutSeconds: 1800 }),
  'target-setup': Object.freeze({ required: true, timeoutSeconds: 900 }),
  feeds: Object.freeze({ required: true, timeoutSeconds: 1800 }),
  config: Object.freeze({ required: true, timeoutSeconds: 900 }),
  build: Object.freeze({ required: true, timeoutSeconds: 21600 }),
  verify: Object.freeze({ required: true, timeoutSeconds: 1800 }),
  publish: Object.freeze({ required: true, timeoutSeconds: 300 }),
});

const OPERATIONS = Object.freeze([
  'activate-target', 'copy-feed-config', 'update-feeds', 'install-feeds',
  'resolve-config', 'build-image', 'verify-image',
] as const);

const TARGET_CONTRACTS: Readonly<Record<TargetId, TargetManifest>> = Object.freeze({
  'rpi-5': Object.freeze({
    id: 'rpi-5', label: 'Pi 5', environment: 'full_raspberrypi_bcm27xx_bcm2712',
    openwrtTarget: 'bcm27xx/bcm2712', profile: 'DEVICE_rpi-5',
    rootfs: 'build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx',
    artifactGlob: 'chirpstack-gateway-os-*-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz',
    rootfsPartSize: 14336, minimumArtifactBytes: 67108864,
    configSymbols: Object.freeze([
      Object.freeze({ name: 'CONFIG_TARGET_bcm27xx_bcm2712', type: 'bool', value: true }),
      Object.freeze({ name: 'CONFIG_TARGET_PROFILE', type: 'string', value: 'DEVICE_rpi-5' }),
      Object.freeze({ name: 'CONFIG_TARGET_ROOTFS_PARTSIZE', type: 'number', value: 14336 }),
      Object.freeze({ name: 'CONFIG_PACKAGE_node-red', type: 'bool', value: true }),
      Object.freeze({ name: 'CONFIG_PACKAGE_node-red-contrib-chirpstack', type: 'bool', value: true }),
      Object.freeze({ name: 'CONFIG_PACKAGE_chirpstack', type: 'bool', value: true }),
      Object.freeze({ name: 'CONFIG_PACKAGE_node-red-node-sqlite', type: 'bool', value: true }),
    ]),
    operations: OPERATIONS,
  }),
  'rpi-2': Object.freeze({
    id: 'rpi-2', label: 'Pi 4 / 400 / 3 / 2', environment: 'full_raspberrypi_bcm27xx_bcm2709',
    openwrtTarget: 'bcm27xx/bcm2709', profile: 'DEVICE_rpi-2',
    rootfs: 'build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx',
    artifactGlob: 'chirpstack-gateway-os-*-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz',
    rootfsPartSize: 14336, minimumArtifactBytes: 67108864,
    configSymbols: Object.freeze([
      Object.freeze({ name: 'CONFIG_TARGET_bcm27xx_bcm2709', type: 'bool', value: true }),
      Object.freeze({ name: 'CONFIG_TARGET_PROFILE', type: 'string', value: 'DEVICE_rpi-2' }),
      Object.freeze({ name: 'CONFIG_TARGET_ROOTFS_PARTSIZE', type: 'number', value: 14336 }),
      Object.freeze({ name: 'CONFIG_PACKAGE_node-red', type: 'bool', value: true }),
      Object.freeze({ name: 'CONFIG_PACKAGE_node-red-contrib-chirpstack', type: 'bool', value: true }),
      Object.freeze({ name: 'CONFIG_PACKAGE_chirpstack', type: 'bool', value: true }),
      Object.freeze({ name: 'CONFIG_PACKAGE_node-red-node-sqlite', type: 'bool', value: true }),
    ]),
    operations: OPERATIONS,
  }),
});

const MANIFEST_KEYS = ['schemaVersion', 'repository', 'stages', 'stageDefinitions', 'targets'];
const REPOSITORY_KEYS = ['name', 'remote'];
const STAGE_DEFINITION_KEYS = ['required', 'timeoutSeconds'];
const TARGET_KEYS = [
  'id', 'label', 'environment', 'openwrtTarget', 'profile', 'rootfs', 'artifactGlob',
  'rootfsPartSize', 'minimumArtifactBytes', 'configSymbols', 'operations',
];
const CONFIG_SYMBOL_KEYS = ['name', 'type', 'value'];
export const MAX_MANIFEST_BYTES = 1024 * 1024;
const INVALID_JSON_MESSAGE = 'Manifest JSON is invalid.';

interface ObjectValidationContext {
  readonly shapeCode: ManifestErrorCode;
  readonly keysCode: ManifestErrorCode;
  readonly shapeMessage: string;
  readonly keysMessage: string;
}

const ROOT_OBJECT_CONTEXT: ObjectValidationContext = {
  shapeCode: 'MANIFEST_ROOT_INVALID',
  keysCode: 'MANIFEST_KEYS_INVALID',
  shapeMessage: 'Expected a manifest JSON object.',
  keysMessage: 'Manifest object contains an unknown or extra key.',
};
const REPOSITORY_OBJECT_CONTEXT: ObjectValidationContext = {
  shapeCode: 'REPOSITORY_SHAPE_INVALID',
  keysCode: 'REPOSITORY_KEYS_INVALID',
  shapeMessage: 'Repository must be a JSON object.',
  keysMessage: 'Repository keys do not match the approved schema.',
};
const STAGE_DEFINITION_OBJECT_CONTEXT: ObjectValidationContext = {
  shapeCode: 'STAGE_DEFINITION_SHAPE_INVALID',
  keysCode: 'STAGE_DEFINITION_KEYS_INVALID',
  shapeMessage: 'Stage definition must be a JSON object.',
  keysMessage: 'Stage definition keys do not match the approved schema.',
};
const TARGET_OBJECT_CONTEXT: ObjectValidationContext = {
  shapeCode: 'TARGET_SHAPE_INVALID',
  keysCode: 'TARGET_KEYS_INVALID',
  shapeMessage: 'Target must be a JSON object.',
  keysMessage: 'Target keys do not match the approved schema.',
};
const CONFIG_SYMBOL_OBJECT_CONTEXT: ObjectValidationContext = {
  shapeCode: 'CONFIG_SYMBOL_SHAPE_INVALID',
  keysCode: 'CONFIG_SYMBOL_KEYS_INVALID',
  shapeMessage: 'Configuration symbol must be a JSON object.',
  keysMessage: 'Configuration symbol keys do not match the approved schema.',
};

function fail(code: ManifestErrorCode, message: string): never {
  throw new ManifestValidationError(code, message);
}

function manifestFailure(code: ManifestErrorCode, message: string): ManifestValidationError {
  return new ManifestValidationError(code, message);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  context: ObjectValidationContext,
): asserts value is Record<string, unknown> {
  if (!isJsonObject(value)) fail(context.shapeCode, context.shapeMessage);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail(context.keysCode, context.keysMessage);
  }
}

function exactArray(value: unknown, expected: readonly string[], code: ManifestErrorCode): void {
  if (!Array.isArray(value) || value.length !== expected.length) fail(code, 'Manifest array does not match the approved cardinality.');
  for (let index = 0; index < expected.length; index += 1) {
    if (value[index] !== expected[index]) fail(code, 'Manifest array does not match the approved order.');
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]));
  }
  return false;
}

function safeRelativePosixPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')) return false;
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

const ARTIFACT_GLOB = /^chirpstack-gateway-os-(?:\*|[A-Za-z0-9._+-]+)-full-bcm27xx-bcm(?:2712-rpi-5|2709-rpi-2)-squashfs-factory\.img\.gz$/;

export function validateArtifactGlob(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('/')
    && !value.includes('\\')
    && ![...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
    && ARTIFACT_GLOB.test(value)
    && value.split('*').length <= 2;
}

function validateStageDefinitions(value: unknown): asserts value is Readonly<Record<PipelineStageName, StageDefinition>> {
  if (!isJsonObject(value)) fail('STAGE_DEFINITION_MISMATCH', 'Stage definitions must be an object.');
  const actualKeys = Object.keys(value);
  if (actualKeys.some((key) => !(PIPELINE_STAGE_NAMES as readonly string[]).includes(key))) {
    fail('UNKNOWN_STAGE', 'Stage definitions contain an unknown stage.');
  }
  if (actualKeys.length !== PIPELINE_STAGE_NAMES.length
    || actualKeys.some((key, index) => key !== PIPELINE_STAGE_NAMES[index])) {
    fail('STAGE_DEFINITION_MISMATCH', 'Stage definitions do not match the approved stages.');
  }
  for (const stage of PIPELINE_STAGE_NAMES) {
    const definition = value[stage];
    exactKeys(definition, STAGE_DEFINITION_KEYS, STAGE_DEFINITION_OBJECT_CONTEXT);
    if (definition.required !== true || typeof definition.timeoutSeconds !== 'number'
      || !Number.isInteger(definition.timeoutSeconds) || definition.timeoutSeconds <= 0
      || definition.timeoutSeconds !== STAGE_DEFINITIONS[stage].timeoutSeconds) {
      fail('STAGE_DEFINITION_INVALID', `Invalid definition for stage ${stage}.`);
    }
  }
}

function validateSymbol(value: unknown, expected: ConfigSymbol): void {
  exactKeys(value, CONFIG_SYMBOL_KEYS, CONFIG_SYMBOL_OBJECT_CONTEXT);
  if (typeof value.name !== 'string' || value.name !== expected.name) fail('CONFIG_SYMBOL_VALUE', 'Unexpected configuration symbol.');
  if (value.type !== 'bool' && value.type !== 'string' && value.type !== 'number') fail('CONFIG_SYMBOL_TYPE', 'Unknown configuration symbol type.');
  if (value.type !== expected.type) fail('CONFIG_SYMBOL_TYPE', 'Configuration symbol type does not match.');
  const valueType = value.type === 'bool' ? 'boolean' : value.type;
  if (typeof value.value !== valueType || (value.type === 'number' && !Number.isFinite(value.value))) {
    fail('CONFIG_SYMBOL_TYPE', 'Configuration symbol value has the wrong type.');
  }
  if (value.value !== expected.value) fail('CONFIG_SYMBOL_VALUE', 'Configuration symbol value does not match.');
}

function validateTarget(value: unknown, expected: TargetManifest): TargetManifest {
  exactKeys(value, TARGET_KEYS, TARGET_OBJECT_CONTEXT);
  if (!isTargetId(value.id)) fail('TARGET_ID_INVALID', 'Unknown target ID.');
  if (value.id !== expected.id) fail('TARGET_ORDER_MISMATCH', 'Targets are not in the approved order.');
  if (typeof value.label !== 'string' || typeof value.environment !== 'string' || typeof value.openwrtTarget !== 'string') fail('TARGET_DATA_MISMATCH', 'Target metadata is invalid.');
  if (typeof value.profile !== 'string' || value.profile.length === 0) fail('MISSING_PROFILE', 'Target profile is required.');
  if (!safeRelativePosixPath(value.rootfs)) fail('UNSAFE_PATH', 'Rootfs path is not a safe relative POSIX path.');
  if (!validateArtifactGlob(value.artifactGlob)) fail('ARTIFACT_GLOB_INVALID', 'Artifact glob is not a factory image filename pattern.');
  if (value.rootfsPartSize !== 14336) fail('ROOTFS_PART_SIZE', 'Rootfs partition size must be 14336.');
  if (value.minimumArtifactBytes !== 67108864) fail('MINIMUM_ARTIFACT_BYTES', 'Minimum artifact size must be 67108864 bytes.');
  if (!Array.isArray(value.configSymbols) || value.configSymbols.length !== expected.configSymbols.length) fail('CONFIG_SYMBOL_INVALID', 'Configuration symbol list is invalid.');
  for (let index = 0; index < expected.configSymbols.length; index += 1) validateSymbol(value.configSymbols[index], expected.configSymbols[index]);
  if (!Array.isArray(value.operations)) fail('UNKNOWN_OPERATION', 'Operations must be an array.');
  const seen = new Set<string>();
  for (const operation of value.operations) {
    if (!isTrustedOperationId(operation)) fail('UNKNOWN_OPERATION', 'Unknown operation ID.');
    if (seen.has(operation)) fail('DUPLICATE_OPERATION', 'Operation IDs must be unique.');
    seen.add(operation);
  }
  if (!sameJson(value.operations, expected.operations)) fail('TARGET_DATA_MISMATCH', 'Target operations do not match the approved operation sequence.');
  if (!sameJson(value, expected)) fail('TARGET_DATA_MISMATCH', 'Target record does not match the approved manifest.');
  return expected;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key), seen);
  return Object.freeze(value);
}

function hasDuplicateKey(root: Node): boolean {
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const child of node.children ?? []) {
        if (child.type !== 'property' || child.children === undefined || child.children.length === 0) continue;
        const keyNode = child.children[0];
        if (keyNode.type === 'string' && typeof keyNode.value === 'string') {
          if (keys.has(keyNode.value)) return true;
          keys.add(keyNode.value);
        }
      }
    }
    for (const child of node.children ?? []) pending.push(child);
  }
  return false;
}

function readManifestBytes(path: string, fileSystem: ManifestFileSystem): Buffer {
  let fd: number | undefined;
  let content: Buffer | undefined;
  let failure: ManifestValidationError | undefined;
  try {
    try {
      fd = fileSystem.open(path);
    } catch {
      throw manifestFailure('MANIFEST_OPEN_FAILED', 'Unable to open manifest.');
    }
    let initialSize: number;
    try {
      initialSize = fileSystem.stat(fd).size;
    } catch {
      throw manifestFailure('MANIFEST_STAT_FAILED', 'Unable to stat manifest.');
    }
    if (!Number.isSafeInteger(initialSize) || initialSize < 0) {
      throw manifestFailure('MANIFEST_STAT_FAILED', 'Unable to stat manifest.');
    }
    if (initialSize > MAX_MANIFEST_BYTES) {
      throw manifestFailure('MANIFEST_TOO_LARGE', 'Manifest exceeds the maximum size.');
    }
    const buffer = Buffer.alloc(initialSize + 1);
    let total = 0;
    while (total < buffer.length) {
      let bytesRead: number;
      try {
        bytesRead = fileSystem.read(fd, buffer, total, buffer.length - total, null);
      } catch {
        throw manifestFailure('MANIFEST_READ_FAILED', 'Unable to read manifest.');
      }
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) {
        throw manifestFailure('MANIFEST_READ_FAILED', 'Unable to read manifest.');
      }
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    let finalSize: number;
    try {
      finalSize = fileSystem.stat(fd).size;
    } catch {
      throw manifestFailure('MANIFEST_STAT_FAILED', 'Unable to stat manifest.');
    }
    if (finalSize !== initialSize || total !== initialSize || total > MAX_MANIFEST_BYTES) {
      throw manifestFailure('MANIFEST_FILE_CHANGED', 'Manifest changed while it was being read.');
    }
    content = Buffer.from(buffer.subarray(0, total));
  } catch (error) {
    failure = error instanceof ManifestValidationError
      ? error
      : manifestFailure('MANIFEST_READ_FAILED', 'Unable to read manifest.');
  } finally {
    if (fd !== undefined) {
      try {
        fileSystem.close(fd);
      } catch {
        if (failure === undefined) failure = manifestFailure('MANIFEST_CLOSE_FAILED', 'Unable to close manifest.');
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (content === undefined) throw manifestFailure('MANIFEST_READ_FAILED', 'Unable to read manifest.');
  return content;
}

export function loadManifest(path: string, fileSystem: ManifestFileSystem = DEFAULT_MANIFEST_FILE_SYSTEM): LoadedManifest {
  const bytes = readManifestBytes(path, fileSystem);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength > MAX_MANIFEST_BYTES) fail('MANIFEST_JSON_INVALID', INVALID_JSON_MESSAGE);
  const text = bytes.toString('utf8');
  const parseErrors: ParseError[] = [];
  let tree: Node | undefined;
  try {
    tree = parseTree(text, parseErrors, {
      allowEmptyContent: false,
      allowTrailingComma: false,
      disallowComments: true,
    });
  } catch {
    fail('MANIFEST_JSON_INVALID', INVALID_JSON_MESSAGE);
  }
  if (tree === undefined || parseErrors.length > 0) fail('MANIFEST_JSON_INVALID', INVALID_JSON_MESSAGE);
  try {
    if (hasDuplicateKey(tree)) fail('DUPLICATE_KEY', 'Manifest contains duplicate key.');
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    fail('MANIFEST_JSON_INVALID', INVALID_JSON_MESSAGE);
  }
  let parsed: unknown;
  try {
    parsed = getNodeValue(tree);
  } catch {
    fail('MANIFEST_JSON_INVALID', INVALID_JSON_MESSAGE);
  }
  exactKeys(parsed, MANIFEST_KEYS, ROOT_OBJECT_CONTEXT);
  if (parsed.schemaVersion !== 1) fail('SCHEMA_VERSION_INVALID', 'Manifest schemaVersion must be 1.');
  exactKeys(parsed.repository, REPOSITORY_KEYS, REPOSITORY_OBJECT_CONTEXT);
  if (parsed.repository.name !== 'osi-os' || parsed.repository.remote !== 'origin') fail('REPOSITORY_INVALID', 'Manifest repository does not match osi-os/origin.');
  if (!Array.isArray(parsed.stages) || parsed.stages.some((stage) => !isPipelineStageName(stage))) fail('UNKNOWN_STAGE', 'Manifest contains an unknown stage.');
  exactArray(parsed.stages, PIPELINE_STAGE_NAMES, 'STAGE_ORDER_MISMATCH');
  validateStageDefinitions(parsed.stageDefinitions);
  if (!Array.isArray(parsed.targets) || parsed.targets.length !== TARGET_IDS.length) fail('TARGETS_INVALID', 'Manifest must contain exactly two targets.');
  const seen = new Set<string>();
  for (const targetValue of parsed.targets) {
    if (isJsonObject(targetValue) && typeof targetValue.id === 'string') {
      if (seen.has(targetValue.id)) fail('DUPLICATE_TARGET_ID', 'Target IDs must be unique.');
      seen.add(targetValue.id);
    }
  }
  const targets: TargetManifest[] = [];
  for (let index = 0; index < TARGET_IDS.length; index += 1) {
    const targetValue = parsed.targets[index];
    targets.push(validateTarget(targetValue, TARGET_CONTRACTS[TARGET_IDS[index]]));
  }
  if (seen.size !== TARGET_IDS.length || !TARGET_IDS.every((id) => seen.has(id))) fail('TARGET_ORDER_MISMATCH', 'Targets are not the approved target set.');
  const manifest: Manifest = {
    schemaVersion: 1,
    repository: { name: 'osi-os', remote: 'origin' },
    stages: PIPELINE_STAGE_NAMES,
    stageDefinitions: STAGE_DEFINITIONS,
    targets,
  };
  deepFreeze(manifest);
  return deepFreeze({ manifest, sha256 });
}
