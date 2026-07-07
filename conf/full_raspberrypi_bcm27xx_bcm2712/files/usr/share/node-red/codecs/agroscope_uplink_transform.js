'use strict';

function numberOrNull(value) {
  var numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFinite(source, keys) {
  for (var i = 0; i < keys.length; i += 1) {
    if (Object.prototype.hasOwnProperty.call(source, keys[i])) {
      var numeric = numberOrNull(source[keys[i]]);
      if (numeric !== null) return numeric;
    }
  }
  return null;
}

function normalizeDevEui(value) {
  var normalized = String(value || '').trim().replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  return normalized || null;
}

function payloadHex(base64Payload) {
  if (!base64Payload) return null;
  try {
    return Buffer.from(String(base64Payload), 'base64').toString('hex');
  } catch (_) {
    return null;
  }
}

function hasChameleonPayload(decoded) {
  return Object.prototype.hasOwnProperty.call(decoded, 'Chameleon_Payload_Version')
    || Object.prototype.hasOwnProperty.call(decoded, 'Chameleon_Array_ID');
}

function isDendrometerProfile(deviceInfo, decoded) {
  var profileName = String(
    (deviceInfo && deviceInfo.deviceProfileName)
      || ''
  ).toUpperCase();

  if (!profileName) return false;
  if (profileName.indexOf('CHAMELEON') >= 0 || hasChameleonPayload(decoded)) return false;
  if (profileName.indexOf('DENDRO') >= 0) return true;
  return profileName.indexOf('LSN50') >= 0 || profileName.indexOf('DRAGINO') >= 0;
}

function toAgroscopeUplink(chirpstackMsg) {
  var data = chirpstackMsg || {};
  var deviceInfo = data.deviceInfo || {};
  var decoded = data.object && typeof data.object === 'object' ? data.object : {};

  if (!isDendrometerProfile(deviceInfo, decoded)) return null;

  var devEui = normalizeDevEui(deviceInfo.devEui || data.devEui);
  var hex = payloadHex(data.data);
  var time = String(data.time || '').trim();
  var adcVoltage = firstFinite(decoded, ['VDC_intput_V', 'VDC_input_V', 'ADC_CH0V', 'adc_ch0v']);
  if (!devEui || !hex || !time || adcVoltage === null) return null;

  var payload = {
    VDC_intput_V: adcVoltage,
  };
  var battery = firstFinite(decoded, ['Bat_V', 'BatV', 'bat_v', 'Battery', 'battery']);
  if (battery !== null) {
    payload = {
      Bat_V: battery,
      VDC_intput_V: adcVoltage,
    };
  }

  return {
    topic: 'OSI_dendro/' + devEui + '/uplink',
    payload: {
      DevEUI_uplink: {
        Time: time,
        DevEUI: devEui,
        FPort: String(data.fPort != null ? data.fPort : ''),
        payload_hex: hex,
        payload: payload,
      },
    },
  };
}

module.exports = {
  toAgroscopeUplink: toAgroscopeUplink,
};
