// Dragino SDI-12-LB/LS uplink decoder (OSI).
// Derived from dragino/dragino-end-node-decoder SDI12_ChirpstackV4_decode.
// FPort 2: [0..1] battery mV (bit15 = EXTI flag), [2] payload version,
//          [3..] ASCII extracted from SDI-12 responses per AT+DATACUTx.
//          payver 2 (AT+DATAUP=1 multi-segment): [3] SegCount [4] SegIndex
//          [5..] ASCII slice for this segment; reassembled by
//          osi-sdi12-reassemble before it reaches the normalizer.
// FPort 5: device status. FPort 100: debug echo of an ad-hoc SDI-12 command.
function decodeUplink(input) {
  return { data: Decode(input.fPort, input.bytes, input.variables) };
}

function asciiFromBytes(bytes, start) {
  var out = '';
  for (var i = start; i < bytes.length; i++) {
    var b = bytes[i];
    if (b >= 0xF0) { i++; continue; }              // vendor control marker skips itself AND the next byte
    if ((b >= 0x20 && b <= 0x7E) || b === 0x0D || b === 0x0A) {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

function Decode(fPort, bytes) {
  if (!bytes || !bytes.length) return {};
  if (fPort === 5) {
    var freqBands = { 0x01: 'EU868', 0x02: 'US915', 0x03: 'IN865', 0x04: 'AU915',
      0x05: 'KZ865', 0x06: 'RU864', 0x07: 'AS923', 0x08: 'AS923-1', 0x09: 'AS923-2',
      0x0A: 'AS923-3', 0x0B: 'CN470', 0x0C: 'EU433', 0x0D: 'KR920', 0x0E: 'MA869' };
    return {
      SENSOR_MODEL: bytes[0] === 0x17 ? 'SDI12-LB/LS' : 'UNKNOWN(0x' + bytes[0].toString(16) + ')',
      FIRMWARE_VERSION: ((bytes[1] & 0x0F) + '.' + ((bytes[2] >> 4) & 0x0F) + '.' + (bytes[2] & 0x0F)),
      FREQUENCY_BAND: freqBands[bytes[3]] || ('UNKNOWN(0x' + bytes[3].toString(16) + ')'),
      SUB_BAND: bytes[4] === 0xFF ? null : bytes[4],
      BAT: ((bytes[5] << 8) | bytes[6]) / 1000
    };
  }
  if (fPort === 100) {
    return { datas_sum: asciiFromBytes(bytes, 0) };
  }
  if (fPort !== 2) {
    // FPort 3 is datalog retrieval (timestamp+length prefixed) in current
    // firmware; decoding it as periodic telemetry writes garbage. Reject
    // every port we do not explicitly support, observably.
    return { unsupported_fport: fPort };
  }
  // FPort 2: periodic sensor payload.
  if (bytes.length < 3) return {};
  var batRaw = (bytes[0] << 8) | bytes[1];
  var payver = bytes[2];
  var common = {
    BatV: (batRaw & 0x7FFF) / 1000,
    EXTI_Trigger: (batRaw & 0x8000) ? 'TRUE' : 'FALSE',
    Payver: payver,
    Node_type: 'SDI12'
  };
  if (payver === 1) {
    common.data_sum = asciiFromBytes(bytes, 3);
    return common;
  }
  if (payver === 2) {
    // AT+DATAUP=1 multi-segment: [bat][bat][payver=2][count][index][ascii slice]
    if (bytes.length < 5) return { unsupported_payload: 'payver2_short' };
    common.SegCount = bytes[3];
    common.SegIndex = bytes[4];
    common.data_sum = asciiFromBytes(bytes, 5);
    return common;
  }
  return { unsupported_payload: 'payver_' + payver };
}
