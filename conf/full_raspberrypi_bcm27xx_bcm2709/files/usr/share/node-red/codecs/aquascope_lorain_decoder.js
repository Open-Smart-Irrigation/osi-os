function round(value, decimals) {
  var factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function readU16(bytes, index) {
  return (((bytes[index] || 0) << 8) | (bytes[index + 1] || 0)) >>> 0;
}

function readU32(bytes, index) {
  return (
    ((bytes[index] || 0) * 0x1000000) +
    (((bytes[index + 1] || 0) << 16) | ((bytes[index + 2] || 0) << 8) | (bytes[index + 3] || 0))
  ) >>> 0;
}

function readSignedTenths(raw) {
  return raw < 0x8000 ? raw / 10 : (raw - 0x10000) / 10;
}

function decodeUplink(input) {
  var fPort = Number(input.fPort);
  if (fPort !== 10 && fPort !== 2) {
    return {
      data: {},
      warnings: [],
      errors: ['LoRain uplinks are expected on FPort 10 or legacy FPort 2']
    };
  }

  var bytes = input.bytes || [];
  var data = {};
  var warnings = [];
  var i = 0;

  while (i < bytes.length) {
    var command = bytes[i++];

    if (command === 0x03) {
      if (i + 2 >= bytes.length) {
        warnings.push('Truncated LoRain hardware block');
        break;
      }

      data.hw_version = bytes[i++];
      data.capabilities = readU16(bytes, i);
      i += 2;
    } else if (command === 0x04) {
      if (i + 2 >= bytes.length) {
        warnings.push('Truncated LoRain config block');
        break;
      }

      var config = bytes[i++];
      var configValue = readU16(bytes, i);
      i += 2;

      if (config === 0x02) {
        data.conf_heartbeat = configValue;
      } else if (config === 0x03) {
        data.conf_heavyrain = configValue;
      } else if (config === 0x04) {
        data.conf_interval = configValue;
      } else if (config === 0x05) {
        data.conf_temperature_calibration = configValue;
      } else {
        warnings.push('Unknown LoRain config command 0x' + config.toString(16));
      }
    } else if (command === 0x06) {
      if (i + 2 >= bytes.length) {
        warnings.push('Truncated LoRain sensor block');
        break;
      }

      var sensor = bytes[i++];
      var sensorValue = readU16(bytes, i);
      i += 2;

      if (sensor === 0x81) {
        data.rainlevel = sensorValue;
        data.rain_tips_delta = sensorValue;
        data.rain_mm_delta = round(sensorValue * 0.5, 1);
      } else if (sensor === 0x01) {
        data.ambient_temperature = round(readSignedTenths(sensorValue), 1);
        data.temperature_C = data.ambient_temperature;
      } else if (sensor === 0x03) {
        data.uptime_days = sensorValue;
      } else {
        warnings.push('Unknown LoRain sensor command 0x' + sensor.toString(16));
      }
    } else if (command === 0x0a) {
      if (i + 3 >= bytes.length) {
        warnings.push('Truncated LoRain firmware block');
        break;
      }

      data.fw_version = readU32(bytes, i);
      i += 4;
    } else if (command === 0x0b) {
      if (i + 3 >= bytes.length) {
        warnings.push('Truncated LoRain alarm block');
        break;
      }

      data.alarm_status = bytes[i++];
      data.alarm_type = bytes[i++];
      data.alarm_value = readU16(bytes, i);
      i += 2;
    } else if (command === 0x12) {
      if (i + 2 >= bytes.length) {
        warnings.push('Truncated LoRain battery block');
        break;
      }

      data.bat_v = round(bytes[i++] / 10, 1);
      data.bat_mAh = readU16(bytes, i);
      i += 2;
    } else {
      warnings.push('Unknown LoRain command 0x' + command.toString(16));
      break;
    }
  }

  return {
    data: data,
    warnings: warnings,
    errors: []
  };
}
