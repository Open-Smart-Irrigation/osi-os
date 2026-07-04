#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(path.resolve(__dirname, '..'), p));
const problems = [];
for (const fp of FLOWS) {
  const func = (JSON.parse(fs.readFileSync(fp, 'utf8')).find((n) => n.id === 'sync-init-fn') || {}).func || '';
  const rel = path.basename(path.dirname(path.dirname(path.dirname(path.dirname(fp)))));
  if (/INSERT OR IGNORE INTO devices_new/.test(func)) problems.push(`${rel}: devices copy still uses INSERT OR IGNORE (silent drop)`);
  if (!/_db\.transaction\s*\(/.test(func)) problems.push(`${rel}: rebuild not inside _db.transaction()`);
  if (!/REQUIRED_TYPES[\s\S]*needsRebuild/.test(func)) problems.push(`${rel}: rebuild not guarded by the live CHECK`);
  const off = func.indexOf('foreign_keys=OFF'), on = func.indexOf('foreign_keys=ON'), fin = func.indexOf('finally');
  if (off < 0 || on < 0 || !(fin >= 0 && fin < on)) problems.push(`${rel}: FK fence must restore foreign_keys=ON in a finally`);
}
if (problems.length) { console.error('verify-devices-rebuild-fence: FAIL'); problems.forEach((p) => console.error('  - ' + p)); process.exit(1); }
console.log(`verify-devices-rebuild-fence: OK (${FLOWS.length} flows)`); process.exit(0);
