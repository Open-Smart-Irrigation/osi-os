#!/usr/bin/env node
'use strict';

// Offline preparation only: this tool never sends commands or writes measurements.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nrRoot = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const normalizer = require(path.join(nrRoot, 'osi-sdi12-normalize'));

function error(code) { return { ok: false, hardware_verified: false, code }; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function preview(input) {
  if (!object(input) || Object.keys(input).some(key => !['configuration', 'uplink'].includes(key))) {
    return error('invalid_input');
  }
  const resolved = normalizer.resolveConfiguration(input.configuration);
  if (!resolved.ok) return error(resolved.code);
  const output = { ok: true, hardware_verified: false, resolved };
  if (!Object.prototype.hasOwnProperty.call(input, 'uplink')) return output;
  const uplink = input.uplink;
  if (!object(uplink) || Object.keys(uplink).sort().join(',') !== 'bytes,fPort'
    || uplink.fPort !== 2 || !Array.isArray(uplink.bytes)
    || uplink.bytes.length < 3 || uplink.bytes.length > 255
    || !Array.from(uplink.bytes).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return error('invalid_uplink');
  }
  const codecPath = path.join(nrRoot, 'codecs/dragino_sdi12_decoder.js');
  const sandbox = { Buffer };
  new vm.Script(fs.readFileSync(codecPath, 'utf8'), { filename: codecPath })
    .runInNewContext(sandbox, { timeout: 1000 });
  const decoded = sandbox.decodeUplink(uplink).data;
  if (decoded.Payver === 2) return error('reassembly_required');
  if (decoded.unsupported_payload || decoded.Payver !== 1) return error('unsupported_payload');
  output.sample = normalizer.normalizeConfigured(decoded, input.configuration, {});
  if (['quarantined', 'partial'].includes(output.sample.disposition)) {
    output.ok = false;
    output.code = 'sample_' + output.sample.disposition;
  }
  return output;
}

function main(args) {
  let input;
  if (args.length === 2 && args[0] === '--example') {
    const examples = JSON.parse(fs.readFileSync(path.join(__dirname,
      'fixtures/device-integration/sdi12/configuration-examples.json'), 'utf8'));
    const example = examples.find(item => item.name === args[1]);
    if (!example) return error('unknown_example');
    input = example.input;
  } else if (args.length === 1 && !args[0].startsWith('--')) {
    let content;
    try { content = fs.readFileSync(args[0], 'utf8'); }
    catch (err) { return error('input_read_failed'); }
    try { input = JSON.parse(content); }
    catch (err) { return error('invalid_json'); }
  } else {
    return error('usage: preview-sdi12-profile.js <input.json> | --example <name>');
  }
  return preview(input);
}

try {
  const output = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = output.ok ? 0 : 1;
} catch (err) {
  process.stdout.write(JSON.stringify(error('preview_failed')) + '\n');
  process.exitCode = 1;
}
