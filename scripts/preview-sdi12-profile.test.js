'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'preview-sdi12-profile.js');
const profilePath = 'files/usr/share/node-red/osi-sdi12-normalize';
const configuration = {
  version: 1, profile_id: 'METER_TEROS_12', profile_version: 2, address: '1',
  settings: { calibration: 'mineral' }, depths: [30],
};
const uplink = { fPort: 2, bytes: [12, 228, 1, ...Buffer.from('+3000-10+0')] };

function runFile(t, value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-preview-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return spawnSync(process.execPath, [script, file], { encoding: 'utf8', cwd: directory });
}

test('preview works outside the repository and invokes the real FPort 2 codec', t => {
  // The real codec strips a vendor control marker and the byte after it.
  // Directly converting all bytes to ASCII would fail this vector.
  const input = { configuration, uplink: { ...uplink,
    bytes: [12, 228, 1, 0xF4, 0x31, ...Buffer.from('+3000-10+0')] } };
  const result = runFile(t, input);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.ok, true);
  assert.equal(preview.hardware_verified, false);
  assert.equal(preview.resolved.acquisition_available, false);
  assert.deepEqual(preview.sample.channels,
    { bat_v: 3.3, vwc_1: 46.81, soil_temp_1: -10, soil_ec_1: 0 });
});

test('preview resolves configurations without requiring readings', t => {
  const result = runFile(t, { configuration });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.resolved.channels.length, 3);
  assert.equal(output.sample, undefined);
});

test('partial previews retain valid measurements but signal diagnostics with a nonzero exit', t => {
  const result = runFile(t, { configuration, uplink: { fPort: 2,
    bytes: [12, 228, 1, ...Buffer.from('+1780+20+0')] } });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.code, 'sample_partial');
  assert.equal(output.ok, false);
  assert.equal(output.hardware_verified, false);
  assert.equal(output.sample.disposition, 'partial');
  assert.deepEqual(output.sample.channels, { bat_v: 3.3, soil_temp_1: 20, soil_ec_1: 0 });
  assert.equal(output.sample.unknown['vwc_1:out_of_range'], 1780);
});

test('invalid config, quarantined measurements and unsupported transport exit nonzero', t => {
  const inputs = [
    {}, null, [], { configuration, command: 'send' },
    { configuration: { ...configuration, version: 3 } },
    { configuration, uplink: null },
    { configuration, uplink: { fPort: 100, bytes: [1, 2, 3] } },
    { configuration, uplink: { fPort: 2, bytes: [12, 228] } },
    { configuration, uplink: { fPort: 2, bytes: [12, 228, 1.1] } },
    { configuration, uplink: { fPort: 2, bytes: [12, 228, 1, -1] } },
    { configuration, uplink: { fPort: 2, bytes: [12, 228, 1, 256] } },
    { configuration, uplink: { fPort: 2, bytes: [12, 228, 2, 2, 0, ...Buffer.from('+3000+20+1')] } },
    { configuration, uplink: { fPort: 2, bytes: [12, 228, 7] } },
    { configuration, uplink: { fPort: 2, bytes: [12, 228, 1, ...Buffer.from('-9999+20+0')] } },
  ];
  for (const input of inputs) {
    const result = runFile(t, input);
    assert.equal(result.status, 1, JSON.stringify(input));
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.hardware_verified, false);
    assert.equal(typeof output.code, 'string');
  }
});

test('invalid JSON, file, example name and arguments return bounded JSON errors', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi12-preview-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json');
  fs.writeFileSync(file, '{');
  for (const args of [[], [file], [path.join(directory, 'missing.json')], ['--example', 'missing'], ['one', 'two', 'three']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(result.stderr, '');
  }
});

test('every documented example has explicit provenance and independently pinned expectations', () => {
  const examples = JSON.parse(fs.readFileSync(path.join(__dirname,
    'fixtures/device-integration/sdi12/configuration-examples.json'), 'utf8'));
  assert.deepEqual(examples.map(example => example.name).sort(),
    ['hydrascout-blocked', 'pr2-4', 'pr2-6', 'tensiomark-pf', 'teros11', 'teros12']);
  for (const example of examples) {
    assert.equal(example.evidence, 'synthetic');
    const result = spawnSync(process.execPath, [script, '--example', example.name], { encoding: 'utf8' });
    assert.equal(result.status, example.expected_code ? 1 : 0, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hardware_verified, false);
    if (example.expected_code) assert.equal(output.code, example.expected_code);
    else assert.deepEqual(output.sample.channels, example.expected_channels);
  }
});

test('the extra runtime file is fetched to its exact module path and profile mirrors match', () => {
  const deploy = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');
  assert.match(deploy, /fetch_required "osi-sdi12-normalize configuration\.js" \\\n\s+"conf\/full_raspberrypi_bcm27xx_bcm2712\/files\/usr\/share\/node-red\/osi-sdi12-normalize\/configuration\.js" \\\n\s+"\/srv\/node-red\/osi-sdi12-normalize\/configuration\.js"/);
  for (const file of ['index.js', 'configuration.js', 'configuration.test.js']) {
    assert.equal(fs.readFileSync(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712', profilePath, file), 'utf8'),
      fs.readFileSync(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709', profilePath, file), 'utf8'));
  }
});
