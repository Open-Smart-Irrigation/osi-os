#!/usr/bin/env node
'use strict';
// Trusted launcher code: never execute an archive's verifier to verify itself.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function archive(bytes) {
  const tar = zlib.gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map();
  const dirs = new Set();
  const seen = new Set();
  let longName;
  let ended = false;
  const string = b => b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)).toString('utf8');
  const number = b => {
    const text = string(b).trim();
    if (!/^[0-7]+$/.test(text)) throw new Error('invalid tar number');
    return Number.parseInt(text, 8);
  };
  for (let offset = 0; offset < tar.length;) {
    if (offset + 512 > tar.length) throw new Error('truncated tar header');
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) {
      if (longName || offset + 1024 > tar.length || !tar.subarray(offset).every(b => b === 0)) throw new Error('invalid tar trailer');
      ended = true;
      break;
    }
    const sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== number(header.subarray(148, 156))) throw new Error('tar checksum mismatch');
    const size = number(header.subarray(124, 136));
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > tar.length) throw new Error('truncated tar data');
    const data = tar.subarray(offset + 512, offset + 512 + size);
    const type = header[156];
    let name = string(header.subarray(0, 100));
    if (string(header.subarray(257, 263)) === 'ustar' && header[263] === 48) {
      const prefix = string(header.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    if (type === 76) {
      if (longName) throw new Error('repeated tar long name');
      longName = string(data);
      offset = next;
      continue;
    }
    if (![0, 48, 53].includes(type)) throw new Error('archive contains a link or special entry');
    name = longName || name;
    longName = undefined;
    name = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (name === '' || name === '.') {
      if (type !== 53) throw new Error('invalid archive root');
    } else {
      if (!/^[\x20-\x7e]+$/.test(name) || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('unsafe archive path');
      if (seen.has(name)) throw new Error('duplicate archive path');
      seen.add(name);
      if (type === 53) { if (size) throw new Error('directory with data'); dirs.add(name); }
      else files.set(name, data);
    }
    offset = next;
  }
  if (!ended) throw new Error('missing tar trailer');
  for (const name of seen) {
    for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) {
      if (files.has(dir)) throw new Error('file is an archive parent');
      dirs.add(dir);
    }
  }
  return { files, dirs };
}
function verifiedBundle(bytes) {
  const tree = archive(bytes);
  const manifest = JSON.parse(tree.files.get('bundle-manifest.json')?.toString('utf8') || 'null');
  if (!manifest || manifest.schema !== 'osi-deploy-bundle/1' || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') throw new Error('invalid manifest');
  const actual = [...tree.files.keys()].filter(n => n !== 'bundle-manifest.json');
  if (!actual.length || actual.length !== Object.keys(manifest.files).length) throw new Error('manifest inventory mismatch');
  for (const name of actual) {
    if (!Object.hasOwn(manifest.files, name) || hash(tree.files.get(name)) !== manifest.files[name]) throw new Error('manifest hash mismatch');
  }
  if (!tree.files.has('deploy.sh') || !tree.files.has('scripts/deploy-bundle-manifest.js') || !tree.files.has('react_gui.tar.gz')) throw new Error('missing deploy input');
  // Validate the entire nested archive before any deploy code or service action.
  archive(tree.files.get('react_gui.tar.gz'));
  // Retain the original manifest expectations for the server's owned copy.
  tree.hashes = Object.fromEntries([...Object.entries(manifest.files), ['bundle-manifest.json', hash(tree.files.get('bundle-manifest.json'))]]);
  return tree;
}
function extract(tree, dest) {
  fs.mkdirSync(dest, { mode: 0o700 });
  for (const dir of [...tree.dirs].sort((a, b) => a.length - b.length || a.localeCompare(b))) fs.mkdirSync(path.join(dest, dir), { mode: 0o755 });
  for (const [name, bytes] of tree.files) fs.writeFileSync(path.join(dest, name), bytes, { flag: 'wx', mode: 0o644 });
}
if (require.main === module) {
  try {
    if (process.argv[2] !== 'extract-gui' || process.argv.length !== 5) throw new Error('usage: deploy-archive.js extract-gui <archive> <new-directory>');
    extract(archive(fs.readFileSync(process.argv[3])), process.argv[4]);
  } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
module.exports = { archive, verifiedBundle, extract, hash };
