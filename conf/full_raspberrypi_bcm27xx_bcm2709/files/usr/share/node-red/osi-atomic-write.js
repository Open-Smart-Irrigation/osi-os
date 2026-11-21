'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

// Resolve the parent and final symlinks, even if a final target is absent.
function realTarget(file) {
  for (let hops = 0; hops < 40; hops++) {
    const dir = fs.realpathSync(path.dirname(file));
    file = path.join(dir, path.basename(file));
    try {
      file = path.resolve(dir, fs.readlinkSync(file));
    } catch (error) {
      if (error.code === 'EINVAL' || error.code === 'ENOENT') return file;
      throw error;
    }
  }
  throw new Error('too many symlinks resolving ' + file);
}

function writeAtomic(file, content, { mode } = {}) {
  const target = realTarget(file);
  const previous = fs.statSync(target, { throwIfNoEntry: false });
  if (previous && !previous.isFile()) throw new Error('expected a regular file at ' + target);

  const bytes = Buffer.from(content);
  const previousMode = previous && (previous.mode & 0o7777);
  const nextMode = mode ?? previousMode ?? 0o644;
  if (previous && previousMode === nextMode && fs.readFileSync(target).equals(bytes)) return false;

  const temp = target + '.tmp-' + randomUUID();
  const saved = temp + '.previous';
  const dir = fs.openSync(path.dirname(target), 'r');
  let staged = false;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    staged = true;
    try {
      if (previous) {
        const { uid, gid } = fs.fstatSync(fd);
        if (uid !== previous.uid || gid !== previous.gid) fs.fchownSync(fd, previous.uid, previous.gid);
      }
      fs.fchmodSync(fd, nextMode);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Keep the old inode linked until publication has been synced.
    if (previous) fs.linkSync(target, saved);
    try {
      fs.renameSync(temp, target);
      staged = false;
    } catch (error) {
      if (previous) fs.unlinkSync(saved);
      throw error;
    }
    try {
      fs.fsyncSync(dir);
    } catch (error) {
      try {
        if (previous) fs.renameSync(saved, target);
        else fs.unlinkSync(target);
        fs.fsyncSync(dir);
      } catch (rollbackError) {
        throw new Error(error.message + '. Rollback could not be synced: ' + rollbackError.message);
      }
      throw error;
    }
    // Publication has committed. A cut before cleanup reaches disk may
    // leave this extra link, but it cannot change the published path.
    if (previous) {
      try {
        fs.unlinkSync(saved);
      } catch (error) {
        console.warn('Could not remove atomic write rollback link for ' + target + ': ' + error.message);
      }
    }
    return true;
  } finally {
    try {
      if (staged) fs.unlinkSync(temp);
    } finally {
      fs.closeSync(dir);
    }
  }
}

module.exports = { writeAtomic };

function checkSyntax(command, args, bytes, language) {
  const result = require('node:child_process').spawnSync(command, args, {
    input: bytes, stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('invalid ' + language + ' syntax');
}

function validateDownload(bytes, target, mode, pin) {
  const source = bytes.toString('utf8');
  if (!source.trim() || source.includes('\0')) throw new Error('empty or binary response');
  if (mode === '755') {
    const shebang = /^#![ \t]*\/bin\/sh(?:[ \t]+\/etc\/rc\.common)?[ \t]*\n/.exec(source);
    if (!shebang || !source.slice(shebang[0].length).trim()) {
      throw new Error('expected a shell shebang and script body');
    }
    checkSyntax('sh', ['-n'], bytes, 'shell');
    if (createHash('sha256').update(bytes).digest('hex') !== pin) {
      throw new Error('shell download SHA-256 pin mismatch');
    }
    return;
  }

  const name = path.basename(target);
  if (name.endsWith('.json')) {
    let data;
    try {
      data = JSON.parse(source);
    } catch {
      throw new Error('invalid JSON');
    }
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const valid = name === 'edge-channels.json'
      ? Array.isArray(data) && data.length > 0 && data.every(channel => typeof channel?.key === 'string')
      : name === 'package-lock.json'
        ? Number.isInteger(data?.lockfileVersion) && object(data?.packages?.['']?.dependencies)
        : object(data?.dependencies) && Object.keys(data.dependencies).length > 0;
    if (!valid) throw new Error('unexpected JSON shape');
    return;
  }

  // These markers distinguish the shipped JS entry points from an HTML error,
  // an empty program, or a syntactically valid but unrelated response.
  if (name === 'settings.js') {
    if (!/^module\.exports\s*=\s*\{/m.test(source) || !/^\s+flowFile:\s*['"]flows\.json['"]/m.test(source)) {
      throw new Error('expected settings entry point');
    }
  } else if (name === 'chirpstack-bootstrap.js') {
    if (!/^run\(process\.argv\.slice\(2\)\)\.catch\(/m.test(source)) {
      throw new Error('expected bootstrap entry point');
    }
  } else if (name === 'agroscope_uplink_transform.js') {
    if (!/^\s+toAgroscopeUplink:\s*toAgroscopeUplink,?$/m.test(source)) {
      throw new Error('expected Agroscope transform entry point');
    }
  } else if (name.endsWith('_decoder.js')) {
    if (!/^function decodeUplink\s*\(/m.test(source)) throw new Error('expected codec entry point');
  } else if (name !== 'osi-atomic-write.js' && name !== '.payload-swap.js') {
    throw new Error('unknown deploy file type');
  }
  checkSyntax(process.execPath, ['--check'], bytes, 'JavaScript');
}

if (require.main === module) {
  const [download, target, mode, pin] = process.argv.slice(2);
  try {
    if (mode !== '644' && mode !== '755') throw new Error('unknown deploy file mode');
    const bytes = fs.readFileSync(download);
    validateDownload(bytes, target, mode, pin);
    // Publish the same bytes checked above. Existing data files retain their
    // permissions. Entry points are executable from the instant of the rename.
    writeAtomic(target, bytes, { mode: mode === '755' ? 0o755 : undefined });
  } catch (error) {
    console.error('ERROR: could not publish ' + target + ': ' + error.message);
    process.exitCode = 1;
  }
}
