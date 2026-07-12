// Milesight UC512 solenoid valve controller — uplink decoder + downlink encoder
// Adapted from Milesight-IoT/SensorDecoders (MIT license).
// TLV format: each field starts with [channel_id, type_id, ...data].
// Reference: UC500 Series Communication Protocol v1.x
'use strict';

function decodeUplink(input) {
  return { data: decode(input.bytes) };
}

function decode(bytes) {
  var decoded = {};
  var i = 0;
  while (i < bytes.length) {
    var channel = bytes[i++];
    var type = bytes[i++];

    if (channel === 0x01 && type === 0x75) {
      decoded.battery = bytes[i++];
    } else if (channel === 0x03 && type === 0x01) {
      decoded.valve_1 = bytes[i++] === 0 ? 'close' : 'open';
    } else if (channel === 0x05 && type === 0x01) {
      decoded.valve_2 = bytes[i++] === 0 ? 'close' : 'open';
    } else if (channel === 0x04 && type === 0xC8) {
      decoded.valve_1_pulse = readUint32LE(bytes, i);
      i += 4;
    } else if (channel === 0x06 && type === 0xC8) {
      decoded.valve_2_pulse = readUint32LE(bytes, i);
      i += 4;
    } else if (channel === 0x07 && type === 0x73) {
      decoded.pressure = readInt16LE(bytes, i) / 10;
      i += 2;
    } else if (channel === 0x08 && type === 0x01) {
      decoded.gpio_1 = bytes[i++];
    } else if (channel === 0x09 && type === 0x01) {
      decoded.gpio_2 = bytes[i++];
    } else if (channel === 0xFF && type === 0x1D) {
      var taskChannel = bytes[i++];
      var taskStatus = bytes[i++];
      var key = taskChannel === 1 ? 'valve_1_task_status' : 'valve_2_task_status';
      decoded[key] = taskStatus === 0 ? 'success' : 'failed';
    } else {
      break;
    }
  }
  return decoded;
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    ((bytes[offset + 3] << 24) >>> 0)
  );
}

function readInt16LE(bytes, offset) {
  var val = bytes[offset] | (bytes[offset + 1] << 8);
  if (val > 0x7FFF) val -= 0x10000;
  return val;
}

function encodeValveTask(params) {
  var valve_index = params.valve_index;
  var valve_status = params.valve_status;
  var duration = params.duration || 0;
  var sequence_id = params.sequence_id || 0;

  if (valve_index !== 1 && valve_index !== 2) {
    throw new Error('valve_index must be 1 or 2');
  }
  if (valve_status === 'open' && (!duration || duration <= 0)) {
    throw new Error('duration must be > 0 for open commands (DD17 safety)');
  }
  if (duration > 0xFFFFFF) {
    throw new Error('duration exceeds 24-bit max (16777215 seconds)');
  }

  var action = valve_status === 'open' ? 0x01 : 0x00;
  return [
    0xFF,
    0x1D,
    valve_index,
    action,
    duration & 0xFF,
    (duration >> 8) & 0xFF,
    (duration >> 16) & 0xFF,
    sequence_id & 0xFF,
  ];
}

if (typeof module !== 'undefined') {
  module.exports = { decodeUplink, encodeValveTask };
}
