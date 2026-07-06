#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.resolve(repoRoot, 'database/migrations/ordered');
const DEFAULT_BASE_REF = 'origin/main';
const MIGRATION_NAME_RE = /^(\d{4})__[a-z0-9_]+\.sql$/;

function parseArgs(argv) {
  const options = {
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    manifestPath: null,
    baseMigrationsDir: null,
    baseRef: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--migrations-dir') {
      i += 1;
      if (!argv[i]) throw new Error('--migrations-dir requires a path');
      options.migrationsDir = path.resolve(argv[i]);
    } else if (arg === '--checksum-manifest') {
      i += 1;
      if (!argv[i]) throw new Error('--checksum-manifest requires a path');
      options.manifestPath = path.resolve(argv[i]);
    } else if (arg === '--base-migrations-dir') {
      i += 1;
      if (!argv[i]) throw new Error('--base-migrations-dir requires a path');
      options.baseMigrationsDir = path.resolve(argv[i]);
    } else if (arg === '--base-ref') {
      i += 1;
      if (!argv[i]) throw new Error('--base-ref requires a ref');
      options.baseRef = argv[i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.manifestPath) {
    options.manifestPath = path.join(options.migrationsDir, 'CHECKSUMS.json');
  }
  if (!options.baseMigrationsDir && !options.baseRef && options.migrationsDir === DEFAULT_MIGRATIONS_DIR) {
    options.baseRef = process.env.OSI_MIGRATIONS_BASE_REF || DEFAULT_BASE_REF;
  }

  return options;
}

function readChecksumManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new Error(`checksum manifest missing: ${manifestPath}`);
    }
    throw new Error(`checksum manifest is invalid JSON: ${e.message}`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('checksum manifest must be an object mapping filename to sha256');
  }

  return parsed;
}

function readOptionalChecksumManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  return readChecksumManifest(manifestPath);
}

function verifyChecksumManifest(migrations, manifestPath) {
  const manifest = readChecksumManifest(manifestPath);
  const migrationNames = new Set(migrations.map((m) => m.name));

  for (const migration of migrations) {
    if (!Object.prototype.hasOwnProperty.call(manifest, migration.name)) {
      throw new Error(`missing checksum manifest entry for ${migration.name}`);
    }
    const expected = manifest[migration.name];
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`invalid checksum manifest entry for ${migration.name}`);
    }
    if (expected !== migration.checksum) {
      throw new Error(
        `checksum mismatch for ${migration.name} (expected ${expected}, got ${migration.checksum})`
      );
    }
  }

  for (const filename of Object.keys(manifest).sort()) {
    if (!migrationNames.has(filename)) {
      throw new Error(`checksum manifest entry has no migration file: ${filename}`);
    }
  }

  return manifest;
}

function migrationVersion(filename) {
  const match = MIGRATION_NAME_RE.exec(filename);
  if (!match) throw new Error(`bad base migration filename: ${filename}`);
  return Number(match[1]);
}

function checksumBuffer(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function snapshotFromDirectory(dir) {
  const files = new Map();
  for (const filename of fs.readdirSync(dir).sort()) {
    if (!filename.endsWith('.sql')) continue;
    migrationVersion(filename);
    const raw = fs.readFileSync(path.join(dir, filename));
    files.set(filename, checksumBuffer(raw));
  }
  return {
    files,
    manifest: readOptionalChecksumManifest(path.join(dir, 'CHECKSUMS.json')),
  };
}

function gitOutput(args, options = {}) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: options.encoding ?? 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error(`${options.label || 'git command failed'}: ${stderr}`);
  }
}

function snapshotFromGitRef(baseRef) {
  const basePath = 'database/migrations/ordered';
  const listed = gitOutput(
    ['ls-tree', '-r', '--name-only', baseRef, '--', basePath],
    { label: `base ref unavailable (${baseRef})` }
  )
    .split('\n')
    .filter(Boolean);
  const files = new Map();
  let manifest = null;

  for (const repoPath of listed.sort()) {
    const filename = path.basename(repoPath);
    if (repoPath === `${basePath}/CHECKSUMS.json`) {
      const raw = gitOutput(['show', `${baseRef}:${repoPath}`], {
        label: `cannot read base checksum manifest (${baseRef})`,
      });
      manifest = JSON.parse(raw);
      continue;
    }
    if (!filename.endsWith('.sql')) continue;
    migrationVersion(filename);
    const raw = gitOutput(['show', `${baseRef}:${repoPath}`], {
      encoding: 'buffer',
      label: `cannot read base migration ${filename} (${baseRef})`,
    });
    files.set(filename, checksumBuffer(raw));
  }

  return { files, manifest };
}

function loadBaseSnapshot(options) {
  if (options.baseMigrationsDir) return snapshotFromDirectory(options.baseMigrationsDir);
  if (options.baseRef) return snapshotFromGitRef(options.baseRef);
  return null;
}

function verifyBaseImmutability(migrations, manifest, options) {
  const base = loadBaseSnapshot(options);
  if (!base) return false;

  const currentByName = new Map(migrations.map((m) => [m.name, m]));
  let baseMaxVersion = 0;
  for (const [filename, checksum] of base.files) {
    baseMaxVersion = Math.max(baseMaxVersion, migrationVersion(filename));
    const current = currentByName.get(filename);
    if (!current) throw new Error(`base migration missing: ${filename}`);
    if (current.checksum !== checksum) throw new Error(`base migration changed: ${filename}`);
  }

  for (const migration of migrations) {
    if (!base.files.has(migration.name) && migration.version <= baseMaxVersion) {
      throw new Error(`new migration ${migration.name} must be after base version ${baseMaxVersion}`);
    }
  }

  if (base.manifest) {
    for (const [filename, checksum] of Object.entries(base.manifest).sort()) {
      if (!Object.prototype.hasOwnProperty.call(manifest, filename)) {
        throw new Error(`base checksum manifest entry missing: ${filename}`);
      }
      if (manifest[filename] !== checksum) {
        throw new Error(`base checksum manifest entry changed: ${filename}`);
      }
    }
  }

  return true;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const migrations = loadMigrations(options.migrationsDir);
  let prev = 0;
  for (const m of migrations) {
    if (m.version !== prev + 1) {
      throw new Error(`non-contiguous version at ${m.name} (expected ${prev + 1}, got ${m.version})`);
    }
    prev = m.version;
  }
  if (migrations.length === 0) throw new Error('no migrations found');
  if (migrations[0].version !== 1) throw new Error('first migration must be version 0001');
  const manifest = verifyChecksumManifest(migrations, options.manifestPath);
  const checkedBase = verifyBaseImmutability(migrations, manifest, options);
  console.log(
    `verify-migrations: OK (${migrations.length} migrations, checksum manifest OK${
      checkedBase ? ', base immutability OK' : ''
    })`
  );
  process.exit(0);
} catch (e) {
  console.error(`verify-migrations: FAIL — ${e.message}`);
  process.exit(1);
}
