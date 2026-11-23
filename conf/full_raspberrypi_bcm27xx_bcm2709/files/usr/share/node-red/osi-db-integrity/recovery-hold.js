'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const SERVICES = ['osi-identityd', 'node-red'];
const HOLD_SUFFIX = '.osi-recovery';
const OLD_MARKERS = ['.legacy-device-fk-repair.lock', '.legacy-device-fk-writer-hold'];
const present = file => fs.lstatSync(file, { throwIfNoEntry: false });
// This exact module also ships beside osi-db-integrity; parity is tested.
function repairHoldRecord(dbPath, { ownedLock } = {}) {
  const dir = dbPath + HOLD_SUFFIX;
  const entry = present(dir);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error('unproven database recovery hold');
  const receipt = path.join(dir, 'receipt.json');
  if (!present(receipt)?.isFile() || present(receipt).isSymbolicLink()) throw new Error('unproven recovery receipt');
  const record = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (record.kind !== 'legacy-device-fk' || record.phase !== 'disabled' ||
      !Array.isArray(record.services) || record.services.length !== SERVICES.length ||
      record.services.some((s, i) => s.name !== SERVICES[i] || typeof s.enabled !== 'boolean')) throw new Error('incomplete legacy repair writer hold');
  // Only the canonical gateway path (or a relocated fixture of that path)
  // owns service enablement. A generic DB hold can never authorize a start.
  const suffix = '/data/db/farming.db';
  if (!dbPath.endsWith(suffix)) throw new Error('writer hold is not for the gateway database');
  const root = dbPath.slice(0, -suffix.length) || '/';
  const links = fs.readdirSync(path.join(root, 'etc/rc.d'));
  if (SERVICES.some(name => links.some(link => /^S\d\d/.test(link) && link.slice(3) === name))) throw new Error('writer autostart was re-enabled during recovery');
  for (const old of OLD_MARKERS) {
    const entry = present(dbPath + old);
    if (!entry) continue;
    if (old === '.legacy-device-fk-repair.lock' && ownedLock && entry.isDirectory() && !entry.isSymbolicLink() && entry.dev === ownedLock.dev && entry.ino === ownedLock.ino) continue;
    throw new Error('incomplete repair evidence: ' + old);
  }
  return record;
}
function assertRepairHealth(dbPath, flowsPath) {
  repairHoldRecord(dbPath);
  if (!present(dbPath)?.isFile() || present(dbPath).isSymbolicLink()) throw new Error('missing regular repaired database');
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const init = flows.find(n => n.id === 'sync-init-fn');
  if (!init || /writable_schema|UPDATE\s+sqlite_master/i.test(init.func)) throw new Error('installed payload still contains retired boot surgery');
}
function retiredPayloadIdentity(flowsPath) {
  const root = path.dirname(flowsPath);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'payload-state.json'), 'utf8'));
  const actual = fs.realpathSync(flowsPath);
  if (state.format !== 1 || state.state !== 'healthy' || !state.active ||
      actual !== path.join(root, 'payloads', state.active, 'flows.json')) throw new Error('current payload has no successful deploy health verdict');
  return { active: state.active, flowPath: actual, flowSha256: createHash('sha256').update(fs.readFileSync(actual)).digest('hex') };
}
function assertRepairAccepted(dbPath, flowsPath) {
  const proof = JSON.parse(fs.readFileSync(path.join(dbPath + HOLD_SUFFIX, 'retirement-health.json'), 'utf8'));
  const expected = retiredPayloadIdentity(flowsPath);
  if (proof.kind !== 'legacy-device-retirement-health' || Object.keys(expected).some(key => proof[key] !== expected[key])) throw new Error('retirement health receipt does not match the current payload');
}
module.exports = { SERVICES, HOLD_SUFFIX, OLD_MARKERS, repairHoldRecord, assertRepairHealth, retiredPayloadIdentity, assertRepairAccepted };
