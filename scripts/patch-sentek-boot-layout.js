#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const profiles = ['bcm2712', 'bcm2709'];
const ddlBefore = "sdi12_value_count INTEGER CHECK(sdi12_value_count IS NULL OR (sdi12_value_count BETWEEN 1 AND 8)), FOREIGN KEY";
const ddlAfter = "sdi12_value_count INTEGER CHECK(sdi12_value_count IS NULL OR (sdi12_value_count BETWEEN 1 AND 8)), sdi12_channel_layout_json TEXT, FOREIGN KEY";
const copyBefore = 'sdi12_probe_profile,sdi12_probe_status,sdi12_identity,sdi12_value_count FROM devices';
const copyAfter = 'sdi12_probe_profile,sdi12_probe_status,sdi12_identity,sdi12_value_count,sdi12_channel_layout_json FROM devices';

for (const profile of profiles) {
  const file = path.join(repo, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
  const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const node = flows.find((candidate) => candidate.id === 'sync-init-fn');
  if (!node || typeof node.func !== 'string') throw new Error(`${profile}: sync-init-fn missing`);
  for (const [before, after, label] of [
    [ddlBefore, ddlAfter, 'DEVICES_NEW_DDL'],
    [copyBefore, copyAfter, 'DEVICES_COPY_SQL'],
  ]) {
    const count = node.func.split(before).length - 1;
    if (count !== 1) throw new Error(`${profile}: expected one ${label} patch site, found ${count}`);
    node.func = node.func.replace(before, after);
  }
  fs.writeFileSync(file, `${JSON.stringify(flows, null, 2)}\n`);
}

const [canonical, mirror] = profiles.map((profile) => fs.readFileSync(
  path.join(repo, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`)));
if (!canonical.equals(mirror)) throw new Error('maintained profile flows diverged after patch');
console.log('patched Sentek layout preservation into both guarded devices rebuilds');
