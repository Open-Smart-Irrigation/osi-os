import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const DEFAULT_MAX_QUEUE_LENGTH = 50;
export const MIN_DISK_FREE_BYTES = 20 * 1024 ** 3;
export const DEFAULT_BUILDER_LOCK_FILE = 'builder.lock.json';
export const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
export const BUILDER_VERSION_PATTERN = /^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/u;
export const MAX_ROOT_LABEL_BYTES = 128;

const REQUIRED_CONFIG_KEYS = Object.freeze([
  'repositoryPath',
  'approvedOutputRoots',
  'builderLockPath',
]);
const ALLOWED_CONFIG_KEYS = new Set([
  ...REQUIRED_CONFIG_KEYS,
  'maxQueueLength',
  'diskFreeMinimumBytes',
]);
const ROOT_KEYS = Object.freeze(['id', 'label', 'path']);

export class ConfigDocumentValidationError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'ConfigDocumentValidationError';
    this.code = code;
    this.field = field;
  }
}

export class AuthorityTopologyValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'AuthorityTopologyValidationError';
    this.code = 'AUTHORITY_TOPOLOGY_INVALID';
    this.field = field;
  }
}

function reject(code, message, field) {
  throw new ConfigDocumentValidationError(code, message, field);
}

function rejectTopology(message, field) {
  throw new AuthorityTopologyValidationError(message, field);
}

function exactObjectKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function validateRepositoryPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    reject('REPOSITORY_PATH_NOT_ABSOLUTE', `Repository path must be absolute: ${String(value)}`, 'repositoryPath');
  }
  return resolve(value);
}

export function validateApprovedOutputRoots(value) {
  if (!Array.isArray(value) || value.length === 0) {
    reject('OUTPUT_ROOTS_INVALID', 'At least one approved output root is required.', 'approvedOutputRoots');
  }
  const seen = new Set();
  const roots = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !exactObjectKeys(candidate, ROOT_KEYS)
      || typeof candidate.id !== 'string' || typeof candidate.label !== 'string' || typeof candidate.path !== 'string') {
      reject('OUTPUT_ROOTS_INVALID', 'Approved output root entries require exactly id, label, and path.', 'approvedOutputRoots');
    }
    if (!ROOT_ID_PATTERN.test(candidate.id)) {
      reject('OUTPUT_ROOT_ID_INVALID', `Invalid approved output root ID: ${candidate.id}`, 'approvedOutputRoots');
    }
    if (Buffer.byteLength(candidate.label, 'utf8') < 1 || Buffer.byteLength(candidate.label, 'utf8') > MAX_ROOT_LABEL_BYTES
      || /\p{Cc}/u.test(candidate.label)) {
      reject('OUTPUT_ROOTS_INVALID', `Approved output root label must be 1-${MAX_ROOT_LABEL_BYTES} UTF-8 bytes without controls.`, 'approvedOutputRoots');
    }
    if (seen.has(candidate.id)) {
      reject('OUTPUT_ROOT_ID_DUPLICATE', `Duplicate approved output root ID: ${candidate.id}`, 'approvedOutputRoots');
    }
    seen.add(candidate.id);
    if (!isAbsolute(candidate.path) || resolve(candidate.path) !== candidate.path) {
      reject('OUTPUT_ROOT_PATH_NOT_ABSOLUTE', `Approved output root must be an absolute normalized path: ${candidate.path}`, candidate.id);
    }
    return Object.freeze({
      id: candidate.id,
      label: candidate.label,
      path: candidate.path,
    });
  });
  return Object.freeze(roots);
}

export function validateMaxQueueLength(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > DEFAULT_MAX_QUEUE_LENGTH) {
    reject('MAX_QUEUE_INVALID', `maxQueueLength must be an integer from 1 to ${DEFAULT_MAX_QUEUE_LENGTH}.`, 'maxQueueLength');
  }
  return value;
}

export function validateDiskFreeMinimumBytes(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_DISK_FREE_BYTES) {
    reject('DISK_THRESHOLD_INVALID', `diskFreeMinimumBytes must be a safe integer of at least ${MIN_DISK_FREE_BYTES}.`, 'diskFreeMinimumBytes');
  }
  return value;
}

export function validateBuilderLockPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value
    || basename(value) !== DEFAULT_BUILDER_LOCK_FILE) {
    reject('BUILDER_LOCK_PATH_INVALID', 'builderLockPath must be an absolute normalized builder.lock.json path.', 'builderLockPath');
  }
  const version = basename(dirname(value));
  if (!BUILDER_VERSION_PATTERN.test(version)) {
    reject('BUILDER_LOCK_PATH_INVALID', 'builderLockPath must include a versioned installation directory.', 'builderLockPath');
  }
  return value;
}

function canonicalAuthorityPath(value, field) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    rejectTopology(`${field} must be a canonical absolute path.`, field);
  }
  return value;
}

function pathsOverlap(left, right) {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  const contained = (value) => value === ''
    || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  return contained(fromLeft) || contained(fromRight);
}

export function validateAuthorityTopology(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    rejectTopology('Authority topology must be an object.');
  }
  const entries = [
    ['configRoot', canonicalAuthorityPath(value.configRoot, 'configRoot')],
    ['stateRoot', canonicalAuthorityPath(value.stateRoot, 'stateRoot')],
    ['installRoot', canonicalAuthorityPath(value.installRoot, 'installRoot')],
  ];
  let repositoryPath;
  if (value.repositoryPath !== undefined) {
    repositoryPath = canonicalAuthorityPath(value.repositoryPath, 'repositoryPath');
    entries.push(['repositoryPath', repositoryPath]);
  }
  const approvedOutputRoots = value.approvedOutputRoots ?? [];
  if (!Array.isArray(approvedOutputRoots)) {
    rejectTopology('approvedOutputRoots must be an array.', 'approvedOutputRoots');
  }
  const outputs = approvedOutputRoots.map((root, index) => {
    if (!root || typeof root !== 'object' || Array.isArray(root) || typeof root.id !== 'string') {
      rejectTopology('Approved output authority is invalid.', 'approvedOutputRoots');
    }
    const output = Object.freeze({
      id: root.id,
      path: canonicalAuthorityPath(root.path, `approvedOutputRoots[${index}].path`),
    });
    entries.push([`approvedOutputRoots[${index}]`, output.path]);
    return output;
  });
  for (let index = 0; index < entries.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      if (pathsOverlap(entries[index][1], entries[otherIndex][1])) {
        rejectTopology(
          `Authority topology overlap between ${entries[index][0]} and ${entries[otherIndex][0]}.`,
        );
      }
    }
  }
  return Object.freeze({
    configRoot: entries[0][1],
    stateRoot: entries[1][1],
    installRoot: entries[2][1],
    ...(repositoryPath === undefined ? {} : { repositoryPath }),
    ...(value.approvedOutputRoots === undefined
      ? {}
      : { approvedOutputRoots: Object.freeze(outputs) }),
  });
}

export function validateConfigDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reject('CONFIG_FILE_INVALID', 'Configuration must be a JSON object.');
  }
  const keys = Object.keys(raw);
  const unknownKey = keys.find((key) => !ALLOWED_CONFIG_KEYS.has(key));
  if (unknownKey !== undefined) {
    reject('CONFIG_FILE_INVALID', `Unknown configuration key: ${unknownKey}`);
  }
  const missingKey = REQUIRED_CONFIG_KEYS.find((key) => !Object.prototype.hasOwnProperty.call(raw, key));
  if (missingKey !== undefined) {
    reject('CONFIG_FILE_INVALID', `Configuration requires ${REQUIRED_CONFIG_KEYS.join(', ')}.`);
  }
  const maxQueueLength = Object.prototype.hasOwnProperty.call(raw, 'maxQueueLength')
    ? validateMaxQueueLength(raw.maxQueueLength)
    : DEFAULT_MAX_QUEUE_LENGTH;
  const diskFreeMinimumBytes = Object.prototype.hasOwnProperty.call(raw, 'diskFreeMinimumBytes')
    ? validateDiskFreeMinimumBytes(raw.diskFreeMinimumBytes)
    : MIN_DISK_FREE_BYTES;
  return Object.freeze({
    repositoryPath: validateRepositoryPath(raw.repositoryPath),
    approvedOutputRoots: validateApprovedOutputRoots(raw.approvedOutputRoots),
    builderLockPath: validateBuilderLockPath(raw.builderLockPath),
    maxQueueLength,
    diskFreeMinimumBytes,
  });
}
