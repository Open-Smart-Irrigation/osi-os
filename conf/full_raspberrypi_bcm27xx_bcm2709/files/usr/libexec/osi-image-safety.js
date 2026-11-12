#!/usr/bin/node
'use strict';
// Fixture roots are exported arguments. The production CLI has no root override.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const LIVE_ROOT = '/';
const STATUS = 'etc/osi-image-initialization.json';
const REQUIRED = 'etc/osi-image-initialization.required';
const DB = 'data/db/farming.db';
const REFUSAL = 'Image upgrade refused: an image upgrade can erase this gateway\'s farm data. Use deploy.sh for a supported application upgrade. Before any deliberate reset, stop all database writers, take a verified SQLite .backup, copy the backup and required credentials/media off the device, and verify that copy; sysupgrade -b is not a consistent farm backup. See docs/operations/image-upgrade-safety.md. A deliberate console reset is osi-factory-reset --erase-farm-and-radio-state; it erases farm data, accounts, radio devices/keys and local configuration.';
const at = (root, name) => path.join(root, name);
function present(file) {
  try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function regular(file) { return fs.lstatSync(file).isFile(); }
function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomicWrite(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + crypto.randomBytes(8).toString('hex');
  const fd = fs.openSync(tmp, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file); syncDir(path.dirname(file));
}
function readStatus(root) {
  const file = at(root, STATUS);
  if (!present(file)) return null;
  if (!regular(file) || fs.statSync(file).size > 2048) throw new Error('invalid initialization status');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.schema !== 1 || !['fresh', 'ready', 'held', 'failed'].includes(state.phase) ||
      !['fresh', 'unproven'].includes(state.origin) ||
      typeof state.reason !== 'string' || typeof state.step !== 'string') throw new Error('invalid initialization status');
  return state;
}
function record(root, phase, step, reason, origin = ['fresh', 'ready'].includes(phase) ? 'fresh' : 'unproven') {
  const state = { schema: 1, phase, origin, step: String(step).slice(0, 80), reason: String(reason).slice(0, 600), at: new Date().toISOString() };
  atomicWrite(at(root, STATUS), JSON.stringify(state) + '\n'); return state;
}
function sidecar(root) { return ['-wal', '-shm', '-journal'].some(s => present(at(root, DB + s))); }
function radioState(root) {
  const dir = at(root, 'srv/chirpstack');
  return present(dir) && (!fs.lstatSync(dir).isDirectory() || fs.readdirSync(dir).length !== 0);
}
function provisionReason(root) {
  if (radioState(root)) return 'retained ChirpStack state';
  const file = at(root, DB);
  if (!present(file)) return sidecar(root) ? 'orphaned SQLite sidecar' : null;
  try {
    if (!regular(file)) return 'unproven farm database type';
    const rows = execFileSync('sqlite3', ['-readonly', file, '.timeout 1000', 'SELECT EXISTS(SELECT 1 FROM users LIMIT 1);'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (rows === '1') return 'farm database contains an account';
    return rows === '0' ? null : 'unproven farm database result';
  } catch (e) { return 'unproven farm database (unreadable, locked or invalid)'; }
}
function retainedReason(root) {
  if (present(at(root, DB))) return 'retained farm database is unproven; image boot will not migrate it';
  if (sidecar(root)) return 'orphaned SQLite sidecar; refusing to seed';
  if (radioState(root)) return 'retained ChirpStack state without a proven farm database';
  for (const name of ['srv/node-red/flows.json', 'srv/node-red/payloads', 'srv/node-red/package.json', 'srv/node-red/.chirpstack.env', 'etc/osi-bootstrap.done']) {
    if (present(at(root, name))) return 'retained application/provisioning state without a proven farm database';
  }
  return null;
}
function begin(root) {
  let state;
  try { state = readStatus(root); } catch (e) { record(root, 'held', 'inspect', e.message); return false; }
  if (state) return state.origin === 'fresh' && ['fresh', 'failed'].includes(state.phase) && state.step !== 'install';
  const reason = retainedReason(root);
  if (reason) { record(root, 'held', 'inspect', reason); return false; }
  record(root, 'fresh', 'seed', 'empty device; initialization in progress'); return true;
}
// Script 93 exists on a new image and is removed after successful execution.
// A restored 'ready' receipt must not bypass the new image's initial inspection.
function imageEntry(root) {
  let state;
  try { state = readStatus(root); } catch (e) { record(root, 'held', 'image-entry', e.message); return; }
  if (state && state.phase === 'held') return;
  const reason = retainedReason(root) || (state && state.phase === 'ready' ? 'restored initialization receipt is unproven on this image' : null);
  if (reason) record(root, 'held', 'image-entry', reason);
  else record(root, 'fresh', 'seed', 'empty device; initialization in progress');
}
function seed(root) {
  if (!begin(root)) return;
  const dest = at(root, DB);
  if (present(dest)) {
    if (!regular(dest) || !fs.readFileSync(dest).equals(fs.readFileSync(at(root, 'usr/share/db/farming.db')))) {
      record(root, 'held', 'seed', 'fresh initialization database differs from the image seed'); return;
    }
    return;
  }
  if (sidecar(root)) { record(root, 'held', 'seed', 'orphaned SQLite sidecar'); return; }
  atomicWrite(dest, fs.readFileSync(at(root, 'usr/share/db/farming.db')), 0o644);
}
function complete(root) {
  const state = readStatus(root);
  if (!state || state.origin !== 'fresh' || !['fresh', 'failed'].includes(state.phase) || !present(at(root, DB)) || !regular(at(root, DB))) throw new Error('initialization cannot complete');
  record(root, 'ready', 'complete', 'fresh image initialization completed');
}
function runtimeAllowed(root) {
  if (!present(at(root, REQUIRED))) return true; // Application deploy onto an older image.
  let state;
  try { state = readStatus(root); } catch (e) { record(root, 'held', 'startup', e.message); return false; }
  if (state && state.origin === 'fresh' && state.phase === 'ready' && present(at(root, DB)) && regular(at(root, DB))) return true;
  if (state && state.phase === 'ready') record(root, 'held', 'startup', 'farm database missing after initialization; refusing to reseed');
  else if (!state) begin(root);
  return false;
}
function guard(root, entry, args) {
  if (entry === 'sysupgrade' && args.length === 1 && ['-h', '--help', '-l', '--list-backup'].includes(args[0])) return;
  let reason;
  try { reason = provisionReason(root); } catch (e) { reason = 'unproven provisioning state'; }
  if (reason) throw new Error(REFUSAL + ' Reason: ' + reason + '.');
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function install(root) {
  const lock = at(root, 'tmp/osi-image-guard-install.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.mkdirSync(lock, { mode: 0o700 });
  try {
    for (const [name, entry] of [['sbin/sysupgrade', 'sysupgrade'], ['usr/libexec/validate_firmware_image', 'validator']]) {
      const file = at(root, name), stock = file + '.osi-stock', hash = stock + '.sha256';
      if (!regular(file)) throw new Error('refusing non-regular upgrade script: ' + name);
      const bytes = fs.readFileSync(file), wrapped = bytes.includes(Buffer.from('# OSI image-upgrade guard v1\n'));
      if (present(stock)) {
        if (!regular(stock)) throw new Error('invalid stock script: ' + name);
        const saved = fs.readFileSync(stock);
        if (saved.includes(Buffer.from('# OSI image-upgrade guard'))) throw new Error('stock script is a wrapper');
        if (present(hash)) {
          if (!regular(hash) || fs.readFileSync(hash, 'utf8').trim() !== digest(saved)) throw new Error('stock script checksum differs');
        } else if (wrapped || !bytes.equals(saved)) throw new Error('unproven stock script');
        if (!wrapped && !bytes.equals(saved)) throw new Error('installed script differs from retained stock script');
      } else {
        if (wrapped) throw new Error('stock script missing');
        atomicWrite(stock, bytes, 0o755);
      }
      atomicWrite(hash, digest(fs.readFileSync(stock)) + '\n');
      atomicWrite(file, `#!/bin/sh\n# OSI image-upgrade guard v1\n/usr/bin/node '${at(root, 'usr/libexec/osi-image-safety.js')}' guard ${entry} "$@" || exit 1\nexec '${stock}' "$@"\n`, 0o755);
    }
  } finally { fs.rmdirSync(lock); }
}
function factoryReset(root, args, options = {}) {
  if (args.length !== 1 || args[0] !== '--erase-farm-and-radio-state') throw new Error('Use osi-factory-reset --erase-farm-and-radio-state to erase all farm and radio state.');
  const tty = options.tty === undefined ? process.stdin.isTTY && process.stdout.isTTY : options.tty;
  const uid = options.uid === undefined ? process.getuid() : options.uid;
  if (!tty || uid !== 0) throw new Error('Factory reset requires a root console terminal.');
  const mounts = options.mounts === undefined ? fs.readFileSync(at(root, 'proc/mounts'), 'utf8') : options.mounts;
  if (mounts.split('\n').some(line => /^\/(data|srv)(\/|$)/.test(line.split(' ')[1] || '')) ||
      ['data', 'srv'].some(name => present(at(root, name)) && fs.lstatSync(at(root, name)).isSymbolicLink())) {
    throw new Error('Factory reset refused: separately mounted or linked farm/radio storage needs an operator erasure procedure.');
  }
  console.error('Factory reset erases all farm history, accounts, radio devices/keys, credentials and local configuration. The gateway will reboot as an empty device.');
  const run = options.run || ((file, argv) => execFileSync(file, argv, { stdio: 'inherit' }));
  run(at(root, 'sbin/firstboot'), ['-y']); run(at(root, 'sbin/reboot'), []);
}
function main(args, root) {
  const [action, ...rest] = args;
  if (action === 'guard') guard(root, rest[0], rest.slice(1));
  else if (action === 'image-entry') imageEntry(root);
  else if (action === 'install') install(root);
  else if (action === 'seed') {
    seed(root);
    const state = readStatus(root);
    if (state && state.phase === 'failed') process.exitCode = 1;
  }
  else if (action === 'prepare') {
    if (!begin(root)) {
      const state = readStatus(root);
      // 2 is a deliberate hold/already-complete disposition. A retryable
      // failure must keep the defaults script pending in OpenWrt.
      process.exitCode = state && state.phase === 'failed' ? 1 : 2;
    }
  }
  else if (action === 'complete') complete(root);
  else if (action === 'runtime') { if (!runtimeAllowed(root)) process.exitCode = 1; }
  else if (action === 'step') {
    const state = readStatus(root);
    if (!state || state.origin !== 'fresh' || !['fresh', 'failed'].includes(state.phase)) throw new Error('cannot advance unproven image initialization');
    record(root, 'fresh', rest[0], 'fresh image initialization in progress');
  }
  else if (action === 'failed') {
    const state = readStatus(root);
    if (rest[0] !== '0' && state && state.phase !== 'held' && state.phase !== 'ready') record(root, 'failed', state.step, 'seed script exited ' + rest[0] + '; initialization remains held', state.origin);
  } else if (action === 'reset') factoryReset(root, rest);
  else throw new Error('unknown image safety action');
}
module.exports = { provisionReason, readStatus, begin, imageEntry, seed, complete, runtimeAllowed, guard, install, factoryReset };
if (require.main === module) {
  try { main(process.argv.slice(2), LIVE_ROOT); }
  catch (e) {
    console.error('OSI image safety: ' + e.message);
    if (process.argv[2] === 'guard') {
      try { execFileSync('logger', ['-t', 'osi-image-safety', e.message], { stdio: 'ignore', timeout: 1000 }); }
      catch (logError) { console.error('Cannot log image refusal: ' + logError.message); }
    }
    if (['seed', 'prepare', 'complete', 'step'].includes(process.argv[2]) ||
        (process.argv[2] === 'install' && present(at(LIVE_ROOT, REQUIRED)))) {
      try {
        const state = readStatus(LIVE_ROOT);
        if ((!state || state.phase !== 'held') && !(process.argv[2] === 'install' && state && state.phase === 'ready')) {
          record(LIVE_ROOT, 'failed', process.argv[2], e.message, state ? state.origin : 'unproven');
        }
      }
      catch (writeError) { console.error('Cannot record initialization failure: ' + writeError.message); }
    }
    process.exitCode = 1;
  }
}
