'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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

if (require.main === module) {
  const [download, target, mode] = process.argv.slice(2);
  const bytes = fs.readFileSync(download);
  if (!bytes.length) throw new Error('empty download for ' + target);
  // Executable entry points must be executable at the instant of publication.
  // Existing data files retain their permissions.
  writeAtomic(target, bytes, { mode: mode === '755' ? 0o755 : undefined });
}
