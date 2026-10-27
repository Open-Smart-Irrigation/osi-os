'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hook = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/hotplug.d/ntp/70-osi-irrigation-clock');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-clock-'));
const marker = path.join(dir, 'marker.json');
const run = (action, stratum, actionEnv = action) => spawnSync(hook, [], {
  env: { ...process.env, OSI_IRRIGATION_CLOCK_MARKER: marker, OSI_IRRIGATION_CLOCK_BOOT_ID: 'boot-a',
    OSI_IRRIGATION_CLOCK_EPOCH_MS: '100000', OSI_IRRIGATION_CLOCK_UPTIME_MS: '50000',
    ACTION: actionEnv,
    ...(stratum === undefined ? {} : { stratum: String(stratum) }) }, encoding: 'utf8',
});

for (const value of [1, 15]) {
  const result = run('stratum', value);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.deepEqual(saved, { boot_id: 'boot-a', epoch_ms: 100000, uptime_ms: 50000, stratum: value });
}
const before = fs.readFileSync(marker);
for (const [action, value] of [['unsync', 16], ['step', 1], ['periodic', 1], ['unknown', 1], ['', 1], ['stratum', 0], ['stratum', 16], ['stratum', '1.5'], ['stratum', '+1'], ['stratum', 'abc']]) {
  const result = run(action, value);
  assert.equal(result.status, 0, `${action}/${value}: ${result.stderr}`);
  assert.deepEqual(fs.readFileSync(marker), before, `${action}/${value} changed marker`);
}
const missingAction = spawnSync(hook, ['stratum'], { env: { ...process.env, OSI_IRRIGATION_CLOCK_MARKER: path.join(dir, 'missing.json'), stratum: '2', OSI_IRRIGATION_CLOCK_BOOT_ID: 'boot-a', OSI_IRRIGATION_CLOCK_EPOCH_MS: '100000', OSI_IRRIGATION_CLOCK_UPTIME_MS: '50000' }, encoding: 'utf8' });
assert.equal(missingAction.status, 0);
assert.equal(fs.existsSync(path.join(dir, 'missing.json')), false);
fs.unlinkSync(marker);
assert.equal(run('stratum', 0).status, 0);
assert.equal(fs.existsSync(marker), false);
assert.equal(run('unsync', 16).status, 0);
assert.equal(fs.existsSync(marker), false);
console.log('OK (conditional irrigation clock hook)');
