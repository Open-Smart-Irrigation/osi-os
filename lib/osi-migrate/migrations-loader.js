'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseManifest, migrationName, corpusError } = require('./migration-manifest');
const RISK_RE = /^(?:\uFEFF)?(?:[ \t]*\r?\n)*--\s*risk:\s*(additive|destructive|data)\s*(?:\r?\n|$)/;
const snapshots = new WeakMap();
const stableFields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];
const sameStat = (a, b) => stableFields.every((k) => a[k] === b[k]);
function regularRead(file) {
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw corpusError(`not a regular file: ${file}`);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) throw corpusError(`file changed before read: ${file}`);
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameStat(opened, after) || BigInt(raw.length) !== after.size) throw corpusError(`file changed during read: ${file}`);
    return { file, raw, stat: after };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sqlNames(dir) { return fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort(); }
function readMigrationManifest(dir) {
  try { return parseManifest(regularRead(path.join(dir, 'CHECKSUMS.json')).raw); }
  catch (e) { throw corpusError(`CHECKSUMS.json: ${e.message.replace(/^migration corpus: /, '')}`); }
}
function loadMigrationCorpus(dir) {
  const resolved = path.resolve(dir);
  try {
    const root = fs.lstatSync(resolved, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw corpusError('migration root must be a nonsymlink directory');
    const manifestFile = regularRead(path.join(resolved, 'CHECKSUMS.json'));
    const entries = parseManifest(manifestFile.raw);
    const expected = entries.map((e) => e.name).sort();
    const actual = sqlNames(resolved);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw corpusError(`file set mismatch: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
    const reads = [manifestFile], rawByName = new Map(), migrations = [];
    for (const e of entries) {
      const read = regularRead(path.join(resolved, e.name));
      reads.push(read);
      const checksum = crypto.createHash('sha256').update(read.raw).digest('hex');
      if (checksum !== e.checksum) throw corpusError(`checksum mismatch for ${e.name}`);
      const sql = read.raw.toString('utf8');
      const risk = RISK_RE.exec(sql);
      if (!risk) throw corpusError(`migration ${e.name} missing '-- risk: additive|destructive|data' header`);
      rawByName.set(e.name, read.raw);
      migrations.push(Object.freeze({ ...e, sql, risk: risk[1] }));
    }
    for (const read of reads) {
      const now = fs.lstatSync(read.file, { bigint: true });
      if (!now.isFile() || !sameStat(read.stat, now)) throw corpusError(`file changed during corpus load: ${read.file}`);
    }
    const endRoot = fs.lstatSync(resolved, { bigint: true });
    if (!endRoot.isDirectory() || endRoot.isSymbolicLink() || root.dev !== endRoot.dev || root.ino !== endRoot.ino || JSON.stringify(sqlNames(resolved)) !== JSON.stringify(actual)) throw corpusError('directory changed during corpus load');
    const identity = crypto.createHash('sha256').update(manifestFile.raw).digest('hex');
    const corpus = Object.freeze({ dir: resolved, identity, migrations: Object.freeze(migrations) });
    snapshots.set(corpus, rawByName);
    return corpus;
  } catch (e) {
    if (e.code === 'ERR_MIGRATION_CORPUS') throw e;
    throw corpusError(`${resolved}: ${e.message}`);
  }
}
function resolveCorpus(dir, corpus) {
  if (corpus === undefined) return loadMigrationCorpus(dir);
  if (!snapshots.has(corpus) || corpus.dir !== path.resolve(dir)) throw corpusError('invalid or directory-mismatched snapshot');
  return corpus;
}
function loadMigrations(dir) { return loadMigrationCorpus(dir).migrations; }
function materializeMigrations(dest, selections) {
  if (!selections.length) throw corpusError('empty migration selection');
  const output = [], seenNames = new Set(), seenVersions = new Set();
  for (const s of selections) {
    if (!snapshots.has(s.corpus)) throw corpusError('selection requires a validated snapshot');
    const source = s.corpus.migrations.find((m) => m.name === s.name);
    if (!source) throw corpusError(`selection source absent: ${s.name}`);
    const name = s.asName === undefined ? s.name : s.asName;
    const { version } = migrationName(name);
    if (seenNames.has(name) || seenVersions.has(version)) throw corpusError('duplicate selected name/version');
    seenNames.add(name); seenVersions.add(version);
    output.push({ name, checksum: source.checksum, raw: snapshots.get(s.corpus).get(s.name) });
  }
  fs.mkdirSync(dest, { mode: 0o700 }); // parent exists; destination must be new
  for (const e of output) fs.writeFileSync(path.join(dest, e.name), e.raw, { flag: 'wx' });
  const manifest = Object.fromEntries(output.map((e) => [e.name, e.checksum]));
  fs.writeFileSync(path.join(dest, 'CHECKSUMS.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return loadMigrationCorpus(dest);
}
module.exports = { loadMigrations, loadMigrationCorpus, resolveCorpus, readMigrationManifest, materializeMigrations };
