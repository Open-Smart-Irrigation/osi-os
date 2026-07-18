'use strict';
// osi-sync-protocol-state/paths.js — root layout, mode/ownership/symlink
// discipline, and low-level durable-write primitives shared by init/load/
// locks.
//
// Plan facts encoded here (lines 329, 351):
//   - "Create /data/osi-sync without symlink components at mode 0700 for
//     the Node-RED service identity; generation, receipt, head, and
//     activity-database files are 0600."
//   - "All witness directories are separate no-symlink mode-0700
//     directories owned by the Node-RED service identity, not children of
//     root-only /data/osi-deploy; capability/activity files are mode
//     0600."
//   - "Every CLI --activity-witness-root .../command-activity-witnesses
//     deterministically requires that exact sibling head-witness root; no
//     caller can redirect or co-locate it." Implemented below as a fixed
//     leaf-name swap (command-activity-witnesses -> command-activity-head-
//     witnesses) on whatever parent directory the caller supplies, so the
//     relationship is fixed while the root itself stays injectable for
//     tests.

const fs = require('node:fs');
const path = require('node:path');
const { codecError } = require('./codecs');

const DEFAULT_ROOT = '/data/osi-sync';
const DEFAULT_WITNESS_ROOT = '/data/osi-sync-witness/protocol-capability-witnesses';
const DEFAULT_ACTIVITY_WITNESS_ROOT = '/data/osi-sync-witness/command-activity-witnesses';

const ACTIVITY_WITNESS_LEAF = 'command-activity-witnesses';
const ACTIVITY_HEAD_WITNESS_LEAF = 'command-activity-head-witnesses';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const GENERATIONS_DIRNAME = 'generations';
const RESET_RECEIPTS_DIRNAME = 'reset-receipts';
const V2_DISPOSITION_RECEIPTS_DIRNAME = 'v2-disposition-receipts';
const DATABASE_RESTORE_RECEIPTS_DIRNAME = 'database-restore-receipts';
const DATABASE_INTEGRITY_RECEIPTS_DIRNAME = 'database-integrity-receipts';
const CHECKPOINTS_DIRNAME = 'checkpoints';
const LOCK_FILENAME = 'lock.json';

function pathsError(code, message, extra) {
  return codecError(code, message, extra);
}

function generationFilename(generation) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw pathsError('invalid_generation_number', 'generation must be a non-negative safe integer');
  }
  return String(generation).padStart(16, '0') + '.json';
}

function deriveActivityHeadWitnessRoot(activityWitnessRoot) {
  const leaf = path.basename(activityWitnessRoot);
  if (leaf !== ACTIVITY_WITNESS_LEAF) {
    throw pathsError(
      'activity_witness_root_leaf_mismatch',
      `activityWitnessRoot must end in "${ACTIVITY_WITNESS_LEAF}" so the sibling head-witness root is` +
        ' deterministic; no caller can redirect or co-locate it'
    );
  }
  return path.join(path.dirname(activityWitnessRoot), ACTIVITY_HEAD_WITNESS_LEAF);
}

// resolveRoots(options): the single source of truth for every path this
// module touches. Every root is injectable; production defaults match the
// plan's literal paths.
function resolveRoots(options) {
  const opts = options || {};
  const root = opts.root || DEFAULT_ROOT;
  const witnessRoot = opts.witnessRoot || DEFAULT_WITNESS_ROOT;
  const activityWitnessRoot = opts.activityWitnessRoot || DEFAULT_ACTIVITY_WITNESS_ROOT;
  const activityHeadWitnessRoot = deriveActivityHeadWitnessRoot(activityWitnessRoot);
  const capabilityRoot = path.join(root, 'protocol-capabilities');
  return {
    root,
    capabilityRoot,
    generationsDir: path.join(capabilityRoot, GENERATIONS_DIRNAME),
    resetReceiptsDir: path.join(capabilityRoot, RESET_RECEIPTS_DIRNAME),
    v2DispositionReceiptsDir: path.join(capabilityRoot, V2_DISPOSITION_RECEIPTS_DIRNAME),
    databaseRestoreReceiptsDir: path.join(capabilityRoot, DATABASE_RESTORE_RECEIPTS_DIRNAME),
    databaseIntegrityReceiptsDir: path.join(capabilityRoot, DATABASE_INTEGRITY_RECEIPTS_DIRNAME),
    capabilityHeadPath: path.join(capabilityRoot, 'head.json'),
    witnessRoot,
    activityWitnessRoot,
    activityDbPath: path.join(activityWitnessRoot, 'activity.sqlite'),
    activityHeadWitnessRoot,
    checkpointsDir: path.join(activityHeadWitnessRoot, CHECKPOINTS_DIRNAME),
    activityHeadPath: path.join(activityHeadWitnessRoot, 'head.json'),
  };
}

// The four physical roots in the plan's fixed lock order (line 353):
// activity-head-witness, activity-database, capability-witness,
// capability-root.
function fourRootsInLockOrder(roots) {
  return [
    { key: 'activityHeadWitnessRoot', dir: roots.activityHeadWitnessRoot },
    { key: 'activityWitnessRoot', dir: roots.activityWitnessRoot },
    { key: 'witnessRoot', dir: roots.witnessRoot },
    { key: 'capabilityRoot', dir: roots.capabilityRoot },
  ];
}

// ---------------------------------------------------------------------------
// Ownership adapter — injectable so non-root test runs can exercise the
// "owned by the Node-RED service identity" rule without requiring the test
// process to actually run as that service account.
// ---------------------------------------------------------------------------

const defaultOwnershipAdapter = {
  // Called once right after a root directory/file is created. Production
  // default is a no-op: the process already creates the path as itself, so
  // "owned by the Node-RED service identity" is trivially true because that
  // identity IS the running process.
  claimOwner() {},
  // Called during load/lock verification against an fs.Stats. Returns
  // true/false.
  verifyOwner(stat) {
    if (typeof process.getuid !== 'function') return true;
    return stat.uid === process.getuid();
  },
};

// ---------------------------------------------------------------------------
// Symlink / mode discipline
// ---------------------------------------------------------------------------

// Walks every path component that currently exists and rejects a symlink.
// Components that don't exist yet are fine (they're about to be created).
function assertNoSymlinkComponents(targetPath) {
  const parsed = path.parse(path.resolve(targetPath));
  let current = parsed.root;
  const segments = parsed.dir.slice(parsed.root.length).split(path.sep).filter(Boolean);
  segments.push(parsed.base);
  for (const seg of segments) {
    current = path.join(current, seg);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw pathsError('symlink_component', `path component is a symlink: ${current}`, { path: current });
    }
  }
}

// Creates (or verifies) a mode-0700 directory at every level from the first
// missing component down to dirPath, with no symlink components.
//
// options.enforceFrom (review IMPORTANT 3a): absolute path marking where
// the MODULE-OWNED subtree begins. Every PRE-EXISTING directory component
// at or below that path must already be mode 0700 and owned by the
// service identity (via the injectable ownership adapter) or this fails
// closed (dir_wrong_mode / dir_wrong_owner) — a pre-created 0755 root is
// an attack surface, not something to silently adopt. Components ABOVE
// enforceFrom (e.g. /tmp, /data) are only checked for symlink/directory
// type, since the module has no authority over their modes. Without
// enforceFrom, pre-existing components are accepted as before (used only
// by tests that build scaffolding).
function ensureModeDirRecursive(dirPath, ownershipAdapter, options) {
  assertNoSymlinkComponents(dirPath);
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  const enforceFrom = options && options.enforceFrom ? path.resolve(options.enforceFrom) : null;
  const parsed = path.parse(path.resolve(dirPath));
  const segments = parsed.dir.slice(parsed.root.length).split(path.sep).filter(Boolean);
  segments.push(parsed.base);
  let current = parsed.root;
  for (const seg of segments) {
    current = path.join(current, seg);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: DIR_MODE });
      fs.chmodSync(current, DIR_MODE);
      adapter.claimOwner(current);
    } else {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw pathsError('symlink_component', `path component is a symlink: ${current}`, { path: current });
      }
      if (!stat.isDirectory()) {
        throw pathsError('not_a_directory', `expected a directory at ${current}`, { path: current });
      }
      const enforced = enforceFrom !== null && (current === enforceFrom || current.startsWith(enforceFrom + path.sep));
      if (enforced) {
        if ((stat.mode & 0o777) !== DIR_MODE) {
          throw pathsError('dir_wrong_mode', `pre-existing module directory is not mode 0700: ${current}`, {
            path: current,
            mode: (stat.mode & 0o777).toString(8),
          });
        }
        if (!adapter.verifyOwner(stat)) {
          throw pathsError('dir_wrong_owner', `pre-existing module directory is not owned by the service identity: ${current}`, {
            path: current,
          });
        }
      }
    }
  }
}

function fsyncDir(dirPath) {
  const fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// O_EXCL-creates filePath with exact mode-0600 content and fdatasyncs it.
// Never overwrites an existing file (EEXIST propagates to the caller).
function writeExclusiveFile(filePath, buffer, ownershipAdapter) {
  assertNoSymlinkComponents(filePath);
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, FILE_MODE);
  try {
    fs.writeSync(fd, buffer);
    fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, FILE_MODE);
  adapter.claimOwner(filePath);
}

// writeExclusiveOrVerify: creates filePath O_EXCL if absent; if it already
// exists, verifies its bytes are exactly `buffer` (a legitimate resume of
// the same operation reproduces byte-identical output) and performs no
// write. A byte mismatch means two different operations tried to occupy
// the same generation number — that is corruption/fork, not a resume, and
// throws `mismatchCode`.
function writeExclusiveOrVerify(filePath, buffer, ownershipAdapter, mismatchCode) {
  if (!fs.existsSync(filePath)) {
    writeExclusiveFile(filePath, buffer, ownershipAdapter);
    return { created: true };
  }
  assertNoSymlinkComponents(filePath);
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw pathsError('exclusive_write_wrong_type', `existing resume path is not a regular nonsymlink file: ${filePath}`, { path: filePath });
  }
  if ((stat.mode & 0o777) !== FILE_MODE) {
    throw pathsError('exclusive_write_wrong_mode', `existing resume file is not mode 0600: ${filePath}`, { path: filePath });
  }
  if (!adapter.verifyOwner(stat)) {
    throw pathsError('exclusive_write_wrong_owner', `existing resume file is not owned by the service identity: ${filePath}`, { path: filePath });
  }
  const existing = fs.readFileSync(filePath);
  if (!existing.equals(buffer)) {
    throw pathsError(mismatchCode || 'exclusive_write_mismatch', `existing file does not match the expected resumed content: ${filePath}`, { path: filePath });
  }
  return { created: false };
}

// Atomically replaces (or creates) filePath via a same-directory tmp file +
// rename, then fsyncs the parent directory. Used for head.json publication.
function atomicReplaceFile(filePath, buffer, ownershipAdapter) {
  assertNoSymlinkComponents(filePath);
  const adapter = ownershipAdapter || defaultOwnershipAdapter;
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, FILE_MODE);
  try {
    fs.writeSync(fd, buffer);
    fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, filePath);
  fsyncDir(dir);
  adapter.claimOwner(filePath);
}

// Lists lstat-regular files directly under dirPath whose name matches
// `pattern`. Rejects (throws) if any matching name is present but not a
// regular file (e.g. a symlink or directory masquerading as a chain entry).
function listRegularEntries(dirPath, pattern) {
  if (!fs.existsSync(dirPath)) return [];
  const names = fs.readdirSync(dirPath).filter((name) => pattern.test(name));
  const out = [];
  for (const name of names.sort()) {
    const full = path.join(dirPath, name);
    const stat = fs.lstatSync(full);
    if (!stat.isFile()) {
      throw pathsError('chain_entry_not_regular_file', `chain entry is not a regular file: ${full}`, { path: full });
    }
    out.push({ name, path: full, stat });
  }
  return out;
}

// Creates (if absent) the four top-level directories that directly hold
// each root's lock.json, so acquireFourRootLocks always has somewhere to
// write — including on a completely fresh (all-absent) initialization.
// Never touches chain content; an already-existing directory is verified
// (mode 0700 + ownership, fail-closed) from each module-owned root down.
function ensureFourRootDirsForLocking(roots, ownershipAdapter) {
  ensureModeDirRecursive(roots.activityHeadWitnessRoot, ownershipAdapter, { enforceFrom: roots.activityHeadWitnessRoot });
  ensureModeDirRecursive(roots.activityWitnessRoot, ownershipAdapter, { enforceFrom: roots.activityWitnessRoot });
  ensureModeDirRecursive(roots.witnessRoot, ownershipAdapter, { enforceFrom: roots.witnessRoot });
  // The capability tree's module-owned subtree begins at the outer root
  // (/data/osi-sync itself is plan-mandated mode 0700, line 351).
  ensureModeDirRecursive(roots.capabilityRoot, ownershipAdapter, { enforceFrom: roots.root });
}

module.exports = {
  DEFAULT_ROOT,
  DEFAULT_WITNESS_ROOT,
  DEFAULT_ACTIVITY_WITNESS_ROOT,
  ACTIVITY_WITNESS_LEAF,
  ACTIVITY_HEAD_WITNESS_LEAF,
  DIR_MODE,
  FILE_MODE,
  GENERATIONS_DIRNAME,
  RESET_RECEIPTS_DIRNAME,
  V2_DISPOSITION_RECEIPTS_DIRNAME,
  DATABASE_RESTORE_RECEIPTS_DIRNAME,
  DATABASE_INTEGRITY_RECEIPTS_DIRNAME,
  CHECKPOINTS_DIRNAME,
  LOCK_FILENAME,
  pathsError,
  generationFilename,
  deriveActivityHeadWitnessRoot,
  resolveRoots,
  fourRootsInLockOrder,
  defaultOwnershipAdapter,
  assertNoSymlinkComponents,
  ensureModeDirRecursive,
  ensureFourRootDirsForLocking,
  fsyncDir,
  fsyncFile,
  writeExclusiveFile,
  writeExclusiveOrVerify,
  atomicReplaceFile,
  listRegularEntries,
};
