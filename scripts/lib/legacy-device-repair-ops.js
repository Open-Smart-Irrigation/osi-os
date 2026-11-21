'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { checkRuntime } = require('./repair-sqlite-cli');
const SERVICES = ['osi-identityd', 'node-red'];
const DB = '/data/db/farming.db';
const { repairHoldRecord, HOLD_SUFFIX, assertRepairAccepted } = require('../../lib/osi-migrate/recovery-hold');
const HOLD = DB + HOLD_SUFFIX;
function sync(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function receipt(dir, record) {
  const next = path.join(dir, 'receipt.next');
  fs.writeFileSync(next, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  sync(next); fs.renameSync(next, path.join(dir, 'receipt.json')); sync(dir);
}
function service(root, name, action) {
  const result = spawnSync(path.join(root, 'etc/init.d', name), [action], { encoding: 'utf8', env: { ...process.env, IPKG_INSTROOT: root === '/' ? '' : root } });
  if (result.error || result.signal || (result.status !== 0 && (action !== 'enabled' || result.status !== 1))) {
    throw new Error(`cannot prove ${name} ${action}: ${result.error || result.stderr || result.signal || result.status}`);
  }
  return result.status === 0;
}
function autostartLinks(root, name) {
  return fs.readdirSync(path.join(root, 'etc/rc.d')).filter(file => /^S\d\d/.test(file) && file.slice(3) === name);
}
function assertHold(root = '/', ownedLock) {
  const dir = path.join(root, HOLD);
  const record = repairHoldRecord(path.join(root, DB), { ownedLock });
  for (const { name } of record.services) {
    if (service(root, name, 'enabled') || autostartLinks(root, name).length) throw new Error(`autostart is not disabled for ${name}`);
  }
  return record;
}
function prepareOffline({ root = '/' } = {}) {
  const runtime = checkRuntime(); // before any service or persistent change
  const source = path.join(root, DB);
  if (!fs.lstatSync(source).isFile() || fs.realpathSync(source) !== source) throw new Error('offline preparation requires an existing regular main database');
  const dir = path.join(root, HOLD);
  // A pending first-boot enable script could undo the recorded service state.
  for (const file of fs.readdirSync(path.join(root, 'etc/uci-defaults'))) {
    const text = fs.readFileSync(path.join(root, 'etc/uci-defaults', file), 'utf8');
    if (SERVICES.some(name => text.includes(name)) && /\benable\b/.test(text)) throw new Error('pending service enablement at boot; qualify it before offline repair');
  }
  const services = SERVICES.map(name => {
    const enabled = service(root, name, 'enabled');
    const links = autostartLinks(root, name);
    if ((!enabled && links.length) || (enabled && links.length !== 1)) throw new Error('divergent service autostart links; qualify before repair');
    return { name, enabled };
  });
  fs.mkdirSync(dir, { mode: 0o700 }); sync(path.dirname(dir));
  const record = { kind: 'legacy-device-fk', phase: 'disabling', services, runtime };
  receipt(dir, record); // durable prior enablement, before the first disable
  for (const { name } of services) {
    service(root, name, 'disable'); sync(path.join(root, 'etc/rc.d'));
    if (service(root, name, 'enabled') || autostartLinks(root, name).length) throw new Error(`cannot disable autostart for ${name}; retain ${dir}`);
  }
  record.phase = 'disabled'; receipt(dir, record);
  assertHold(root);
  return { hold: dir, services, runtime, writersStopped: false };
}
function backupOnline({ root = '/', backupDir } = {}) {
  checkRuntime();
  if (!backupDir || !/^[A-Za-z0-9_./-]+$/.test(backupDir)) throw new Error('strict online backup requires a plain absolute backup-dir');
  const source = path.join(root, DB);
  if (!fs.lstatSync(source).isFile() || fs.realpathSync(source) !== source) throw new Error('online backup requires an existing regular main database');
  const dest = path.resolve(backupDir);
  if (dest !== backupDir || fs.realpathSync(path.dirname(dest)) !== path.dirname(dest)) throw new Error('unsafe backup directory');
  fs.mkdirSync(dest, { mode: 0o700 }); sync(path.dirname(dest));
  const record = { phase: 'online-backup', database: path.join(root, DB) };
  receipt(dest, record);
  try {
    execFileSync('sqlite3', ['-init', '/dev/null', '-readonly', '-cmd', '.timeout 30000', record.database, `.backup '${path.join(dest, 'farming.db')}'`], { stdio: 'pipe' });
    const integrity = execFileSync('sqlite3', ['-init', '/dev/null', '-readonly', path.join(dest, 'farming.db'), 'PRAGMA integrity_check'], { encoding: 'utf8' }).trim();
    if (integrity !== 'ok') throw new Error('online backup integrity_check failed: ' + integrity);
    for (const [source, target] of [['srv/node-red/flows.json', 'flows.json'], ['srv/node-red/settings.js', 'settings.js'],
      ['srv/node-red/flows_cred.json', 'flows_cred.json'], ['usr/lib/node-red/gui', 'gui']]) {
      execFileSync('cp', ['-aL', path.join(root, source), path.join(dest, target)]);
    }
    function flush(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) flush(p);
        else if (e.isFile()) sync(p);
        else throw new Error('non-regular backup artifact');
      }
      sync(dir);
    }
    flush(dest);
    record.phase = 'verified'; record.integrity = integrity; receipt(dest, record);
    return { backup: dest, integrity };
  } catch (error) {
    record.phase = 'failed'; record.error = error.message; receipt(dest, record);
    throw new Error(`strict online backup failed; retain ${dest}; services were not changed: ${error.message}`);
  }
}
async function releaseHold({ root = '/', verify, checkpoint = async () => {} } = {}) {
  const dir = path.join(root, HOLD);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  if (record.kind !== 'legacy-device-fk' || !Array.isArray(record.services) || record.services.length !== SERVICES.length || record.services.some((s, i) => s.name !== SERVICES[i] || typeof s.enabled !== 'boolean')) throw new Error('unproven writer hold receipt');
  if (!['disabled', 'releasing', 'released'].includes(record.phase)) throw new Error('incomplete hold preparation requires investigation');
  const file = path.join(root, DB);
  if (fs.lstatSync(file + '.legacy-device-fk-repair.lock', { throwIfNoEntry: false })) throw new Error('incomplete repair receipt; keep writer hold');
  const flows = JSON.parse(fs.readFileSync(path.join(root, 'srv/node-red/flows.json'), 'utf8'));
  const init = flows.find(n => n.id === 'sync-init-fn');
  if (!init || /writable_schema|UPDATE\s+sqlite_master/i.test(init.func)) throw new Error('installed payload still contains the retired boot surgery; keep writer hold');
  assertRepairAccepted(file, path.join(root, 'srv/node-red/flows.json'));
  if (!verify) throw new Error('verified deploy and database checks are required before release');
  // Resume a cut release by re-establishing the stopped boot entries first.
  // The hold remains visible throughout; no intermediate phase authorizes boot.
  for (const { name } of record.services) {
    service(root, name, 'disable'); sync(path.join(root, 'etc/rc.d'));
    if (service(root, name, 'enabled') || autostartLinks(root, name).length) throw new Error('cannot re-establish writer hold before release');
  }
  record.phase = 'disabled'; receipt(dir, record);
  assertHold(root);
  await verify(file);
  // A retirement deploy may have staged this boot default while held. Consume
  // only the reviewed hold-aware version, otherwise it could re-enable a
  // service whose original state was disabled after the hold is released.
  const pending = path.join(root, 'etc/uci-defaults/94_osi_identityd_enable');
  if (fs.lstatSync(pending, { throwIfNoEntry: false })) {
    const expected = fs.readFileSync(path.join(__dirname, '../../conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable'));
    if (!fs.lstatSync(pending).isFile() || fs.lstatSync(pending).isSymbolicLink() || !fs.readFileSync(pending).equals(expected)) throw new Error('unknown pending identity enablement; keep the recovery hold');
    fs.unlinkSync(pending); sync(path.dirname(pending));
  }
  record.phase = 'releasing'; receipt(dir, record);
  await checkpoint('releasing');
  for (const { name, enabled } of record.services) {
    service(root, name, enabled ? 'enable' : 'disable'); sync(path.join(root, 'etc/rc.d'));
    if (service(root, name, 'enabled') !== enabled || (!enabled && autostartLinks(root, name).length)) throw new Error('cannot restore original service enablement');
    await checkpoint('restored-' + name);
  }
  record.phase = 'released'; receipt(dir, record);
  await checkpoint('released');
  const archived = dir + '.released-' + Date.now();
  fs.renameSync(dir, archived); sync(path.dirname(dir));
  return { released: true, receipt: path.join(archived, 'receipt.json'), services: record.services };
}
module.exports = { prepareOffline, assertHold, backupOnline, releaseHold };
