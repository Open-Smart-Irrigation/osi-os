'use strict';

var crypto = require('crypto');
var pfToKpa = require('../osi-matric-potential').pfToKpa;

var ADDRESS_RE = /^[0-9A-Za-z]$/;
var RECORD_RE = /^([0-9A-Za-z])([+-][0-9]+\.[0-9]+)([+-][0-9]+\.[0-9]+)\r\n$/;

function invalid(error) {
  return { ok: false, error: error };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}

function validDepth(depth) {
  return depth === null || (Number.isInteger(depth) && depth >= 1 && depth <= 1000);
}

function canonicalSensor(sensor) {
  return {
    address: sensor.address,
    channel: sensor.channel,
    identity: sensor.identity,
    depth_cm: sensor.depth_cm,
    calibration_range: sensor.calibration_range
  };
}

function validateTensiomarkLayout(input) {
  var value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return invalid('invalid_json'); }
  }
  if (!exactKeys(value, ['version', 'kind', 'source_unit', 'field_order', 'qualification', 'sensors'])) {
    return invalid('unexpected_layout_fields');
  }
  if (value.version !== 1 || value.kind !== 'tensiomark') return invalid('unsupported_layout');
  if (value.source_unit !== 'pF' || value.field_order !== 'temperature_pf'
    || value.qualification !== 'bench_observed') return invalid('invalid_interpretation');
  if (!Array.isArray(value.sensors) || value.sensors.length < 1 || value.sensors.length > 2) {
    return invalid('sensor_count');
  }

  var addresses = {};
  var channels = {};
  var depths = {};
  var sensors = [];
  for (var i = 0; i < value.sensors.length; i++) {
    var sensor = value.sensors[i];
    if (!exactKeys(sensor, ['address', 'channel', 'identity', 'depth_cm', 'calibration_range'])) {
      return invalid('unexpected_sensor_fields');
    }
    if (typeof sensor.address !== 'string' || !ADDRESS_RE.test(sensor.address) || addresses[sensor.address]) {
      return invalid('invalid_address');
    }
    if (!Number.isInteger(sensor.channel) || sensor.channel < 1 || sensor.channel > 2 || channels[sensor.channel]) {
      return invalid('invalid_channel');
    }
    var identityPattern = new RegExp('^' + sensor.address + '11TENSIOMARK_2Vh_10A[0-9]{5}$');
    if (typeof sensor.identity !== 'string' || !identityPattern.test(sensor.identity)) {
      return invalid('invalid_identity');
    }
    if (!validDepth(sensor.depth_cm)) return invalid('invalid_depth');
    if (sensor.calibration_range !== 'unverified') return invalid('invalid_calibration_range');
    addresses[sensor.address] = true;
    channels[sensor.channel] = true;
    sensors.push(canonicalSensor(sensor));
  }
  sensors.sort(function (a, b) { return a.channel - b.channel; });
  sensors.forEach(function(sensor) {
    if (sensor.depth_cm !== null) {
      depths['swt_' + sensor.channel] = sensor.depth_cm;
      depths['soil_temp_' + sensor.channel] = sensor.depth_cm;
    }
  });
  var layout = {
    version: 1,
    kind: 'tensiomark',
    source_unit: 'pF',
    field_order: 'temperature_pf',
    qualification: 'bench_observed',
    sensors: sensors
  };
  return {
    ok: true,
    layout: layout,
    depths: depths,
    configurationHash: crypto.createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex')
  };
}

function retainedChannels(decoded) {
  var channels = {};
  if (decoded && Number.isFinite(decoded.BatV)) channels.bat_v = decoded.BatV;
  return channels;
}

function evidence(rawResponse, validation, disposition, channels, nativePf) {
  return {
    rawResponse: rawResponse,
    configurationHash: validation.configurationHash,
    configurationJson: JSON.stringify(validation.layout),
    disposition: disposition,
    channels: channels,
    nativePf: nativePf || {}
  };
}

function refused(decoded, rawResponse, validation, disposition, meta, noResponse) {
  var channels = retainedChannels(decoded);
  return {
    channels: channels,
    unknown: {},
    recordedAt: (meta && meta.recordedAt) || null,
    noResponse: !!noResponse,
    profileId: 'TENSIOMARK',
    tensiomarkObservation: evidence(rawResponse, validation, disposition, channels, {})
  };
}

function normalizeTensiomark(decoded, input, meta) {
  var validation = input && input.ok === true && input.layout ? input : validateTensiomarkLayout(input);
  var rawResponse = decoded && typeof decoded.data_sum === 'string' ? decoded.data_sum : '';
  if (!validation.ok) return null;
  if (rawResponse === '' || rawResponse === 'NULL') {
    return refused(decoded, rawResponse, validation, 'rejected_framing', meta, true);
  }
  if (!rawResponse.endsWith('\r\n')) {
    return refused(decoded, rawResponse, validation, 'rejected_framing', meta, false);
  }
  var lines = rawResponse.split('\r\n');
  lines.pop();
  if (!lines.length || lines.some(function (line) { return line === ''; })) {
    return refused(decoded, rawResponse, validation, 'rejected_framing', meta, false);
  }
  var readings = {};
  for (var i = 0; i < lines.length; i++) {
    var match = RECORD_RE.exec(lines[i] + '\r\n');
    if (!match) return refused(decoded, rawResponse, validation, 'rejected_framing', meta, false);
    var address = match[1];
    if (readings[address]) return refused(decoded, rawResponse, validation, 'rejected_addresses', meta, false);
    readings[address] = { temperature: Number(match[2]), pf: Number(match[3]), pfToken: match[3] };
  }
  var configured = {};
  for (var j = 0; j < validation.layout.sensors.length; j++) configured[validation.layout.sensors[j].address] = true;
  var observed = Object.keys(readings);
  if (observed.length !== validation.layout.sensors.length
    || observed.some(function (address) { return !configured[address]; })) {
    return refused(decoded, rawResponse, validation, 'rejected_addresses', meta, false);
  }

  var channels = retainedChannels(decoded);
  var nativePf = {};
  for (var k = 0; k < validation.layout.sensors.length; k++) {
    var sensor = validation.layout.sensors[k];
    var reading = readings[sensor.address];
    if (!reading || !Number.isFinite(reading.temperature) || !Number.isFinite(reading.pf)
      || reading.temperature < -40 || reading.temperature > 80
      || reading.temperature === -99.88 || reading.pf < 0 || reading.pf > 7) {
      return refused(decoded, rawResponse, validation, 'rejected_values', meta, false);
    }
    channels['soil_temp_' + sensor.channel] = reading.temperature;
    channels['swt_' + sensor.channel] = pfToKpa(reading.pf);
    nativePf['swt_' + sensor.channel] = reading.pfToken;
  }
  return {
    channels: channels,
    unknown: {},
    recordedAt: (meta && meta.recordedAt) || null,
    noResponse: false,
    profileId: 'TENSIOMARK',
    nativePf: nativePf,
    tensiomarkObservation: evidence(rawResponse, validation, 'accepted', channels, nativePf)
  };
}

// Live acquisition must validate original bytes before a lossy shared codec can
// turn a malformed response into valid numeric text. The text-only entry point
// above remains useful for callers that already possess a complete SDI-12 reply.
function normalizeTensiomarkUplink(info, input, meta) {
  var validation = input && input.ok === true && input.layout ? input : validateTensiomarkLayout(input);
  if (!validation.ok) return null;
  var encoded = info && info.payloadBase64;
  var decoded = {};
  var rawResponse = '';
  function reject() {
    return refused(decoded, rawResponse, validation, 'rejected_framing', meta, false);
  }
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4096) return reject();
  var bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return reject();
  if (bytes.length >= 2) decoded.BatV = (((bytes[0] << 8) | bytes[1]) & 0x7fff) / 1000;
  rawResponse = bytes.subarray(3).toString('latin1');
  if (!info || info.fPort !== 2 || bytes.length < 3 || bytes[2] !== 1) return reject();
  var body = bytes.subarray(3);
  if (body.length && body[0] >= 0xf0) {
    var parts = [];
    var slots = new Set();
    var offset = 0;
    while (offset < body.length) {
      var marker = body[offset];
      if (marker < 0xf1 || marker > 0xff || offset + 2 > body.length || slots.has(marker)) return reject();
      slots.add(marker);
      var length = body[offset + 1];
      offset += 2;
      if (offset + length > body.length) return reject();
      parts.push(body.subarray(offset, offset + length));
      offset += length;
    }
    rawResponse = Buffer.concat(parts).toString('latin1');
    // Each wrapper describes one command's complete response, not a fragment.
    if (parts.some(function (part) { return !RECORD_RE.test(part.toString('latin1')); })) return reject();
  }
  decoded.data_sum = rawResponse;
  return normalizeTensiomark(decoded, validation, meta);
}

module.exports = {
  validateTensiomarkLayout: validateTensiomarkLayout,
  normalizeTensiomark: normalizeTensiomark,
  normalizeTensiomarkUplink: normalizeTensiomarkUplink
};
