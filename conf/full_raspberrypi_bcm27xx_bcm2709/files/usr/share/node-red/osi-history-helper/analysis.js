'use strict';

const crypto = require('crypto');

const CHANNELS = [
  { key: 'swt_1', unit: 'kPa', label: 'Soil tension (S1)', cardType: 'soil', edgeField: 'swt_1', exportable: true, deprecated: false },
  { key: 'swt_2', unit: 'kPa', label: 'Soil tension (S2)', cardType: 'soil', edgeField: 'swt_2', exportable: true, deprecated: false },
  { key: 'swt_3', unit: 'kPa', label: 'Soil tension (S3)', cardType: 'soil', edgeField: 'swt_3', exportable: true, deprecated: false },
  { key: 'vwc', unit: '%', label: 'VWC', cardType: 'soil', edgeField: null, exportable: true, deprecated: false },
  { key: 'ambient_temperature', unit: '°C', label: 'Ambient temperature', cardType: 'environment', edgeField: 'ambient_temperature', exportable: true, deprecated: false },
  { key: 'relative_humidity', unit: '%', label: 'Relative humidity', cardType: 'environment', edgeField: 'relative_humidity', exportable: true, deprecated: false },
  { key: 'light_lux', unit: 'lux', label: 'Light', cardType: 'environment', edgeField: 'light_lux', exportable: true, deprecated: false },
  { key: 'ext_temperature_c', unit: '°C', label: 'External temperature', cardType: 'environment', edgeField: 'ext_temperature_c', exportable: true, deprecated: false },
  { key: 'rain_mm_per_hour', unit: 'mm/h', label: 'Rain rate', cardType: 'environment', edgeField: 'rain_mm_per_hour', exportable: true, deprecated: false },
  { key: 'rain_mm_per_10min', unit: 'mm/10min', label: 'Rain (10 min)', cardType: 'environment', edgeField: 'rain_mm_per_10min', exportable: true, deprecated: false },
  { key: 'rain_mm_today', unit: 'mm', label: 'Rain today', cardType: 'environment', edgeField: 'rain_mm_today', exportable: true, deprecated: false },
  { key: 'rain_mm_delta', unit: 'mm', label: 'Rain delta', cardType: 'environment', edgeField: 'rain_mm_delta', exportable: true, deprecated: false },
  { key: 'wind_speed_mps', unit: 'm/s', label: 'Wind speed', cardType: 'environment', edgeField: 'wind_speed_mps', exportable: true, deprecated: false },
  { key: 'wind_gust_mps', unit: 'm/s', label: 'Wind gust', cardType: 'environment', edgeField: 'wind_gust_mps', exportable: true, deprecated: false },
  { key: 'barometric_pressure_hpa', unit: 'hPa', label: 'Pressure', cardType: 'environment', edgeField: 'barometric_pressure_hpa', exportable: true, deprecated: false },
  { key: 'uv_index', unit: null, label: 'UV index', cardType: 'environment', edgeField: 'uv_index', exportable: true, deprecated: false },
  { key: 'dendro_stem_change_um', unit: 'µm', label: 'Stem change', cardType: 'dendro', edgeField: 'dendro_stem_change_um', exportable: true, deprecated: false },
  { key: 'dendro_position_mm', unit: 'mm', label: 'Position', cardType: 'dendro', edgeField: 'dendro_position_mm', exportable: true, deprecated: false },
  { key: 'dendro_position_raw_mm', unit: 'mm', label: 'Position (raw)', cardType: 'dendro', edgeField: 'dendro_position_raw_mm', exportable: true, deprecated: false },
  { key: 'dendro_delta_mm', unit: 'mm', label: 'Delta', cardType: 'dendro', edgeField: 'dendro_delta_mm', exportable: true, deprecated: false },
  { key: 'dendro_ratio', unit: null, label: 'Ratio', cardType: 'dendro', edgeField: 'dendro_ratio', exportable: true, deprecated: false },
  { key: 'adc_ch0v', unit: 'V', label: 'ADC ch0', cardType: 'dendro', edgeField: 'adc_ch0v', exportable: true, deprecated: false },
  { key: 'adc_ch1v', unit: 'V', label: 'ADC ch1', cardType: 'dendro', edgeField: 'adc_ch1v', exportable: true, deprecated: false },
];

const CHANNELS_BY_KEY = new Map(CHANNELS.map((channel) => [channel.key, channel]));

function analysisSeriesId(zoneId, cardType, sourceKey, channelKey) {
  return crypto
    .createHash('sha256')
    .update(`${zoneId}|${cardType}|${sourceKey}|${channelKey}`)
    .digest('hex')
    .slice(0, 16);
}

function normalizeCardType(value) {
  const cardType = String(value || '').trim().toLowerCase();
  return cardType === 'env' ? 'environment' : cardType;
}

function boolFlag(value) {
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true';
}

function cardChannels(cardType) {
  const normalized = normalizeCardType(cardType);
  return CHANNELS
    .filter((channel) => channel.cardType === normalized && channel.exportable !== false && channel.deprecated !== true)
    .map((channel) => channel.key);
}

function filterAvailable(cardType, defaults) {
  const allowed = new Set(cardChannels(cardType));
  return defaults.filter((key) => allowed.has(key));
}

function cardChannelsForSource(cardType, source = null) {
  const normalized = normalizeCardType(cardType);
  if (!source) return cardChannels(normalized);

  if (normalized === 'soil' && boolFlag(source.chameleonEnabled ?? source.chameleon_enabled)) {
    return filterAvailable(normalized, ['swt_1', 'swt_2', 'swt_3']);
  }

  if (normalized === 'environment') {
    const deviceType = String(source.deviceType || source.typeId || source.type_id || '').trim().toUpperCase();
    if (deviceType === 'DRAGINO_LSN50') {
      return boolFlag(source.tempEnabled ?? source.temp_enabled) ? filterAvailable(normalized, ['ext_temperature_c']) : [];
    }
    if (deviceType === 'KIWI_SENSOR') {
      return filterAvailable(normalized, ['ambient_temperature', 'relative_humidity', 'light_lux']);
    }
  }

  return cardChannels(normalized);
}

function channelMeta(channelKey) {
  const key = String(channelKey || '').trim();
  const meta = CHANNELS_BY_KEY.get(key);
  if (!meta) {
    const error = new Error(`unknown analysis channel: ${key}`);
    error.statusCode = 400;
    throw error;
  }
  return {
    key: meta.key,
    label: meta.label,
    unit: meta.unit,
    edgeField: meta.edgeField,
  };
}

function displaySafeDeviceContext(device) {
  return {
    deviceType: device && (device.type_id || device.typeId),
    typeId: device && (device.type_id || device.typeId),
    chameleonEnabled: device && (device.chameleon_enabled || device.chameleonEnabled),
    tempEnabled: device && (device.temp_enabled || device.tempEnabled),
  };
}

function createAnalysis(deps) {
  const {
    dbAll,
    deriveCardsForZone,
    displayDeviceName,
    normalizeDeveui,
    soilDepthCm,
    sourceDevicesForCard,
    sourceKeyForCsv,
  } = deps || {};

  async function buildAnalysisCatalog(db, options = {}) {
    const hubEui = String(options.deviceEui || options.device_eui || '').trim().toUpperCase();
    const zones = await dbAll(db, 'SELECT * FROM irrigation_zones WHERE deleted_at IS NULL ORDER BY id ASC', []);
    const channels = [];
    const entriesById = new Map();

    for (const zone of zones) {
      const devices = await dbAll(db, 'SELECT * FROM devices WHERE deleted_at IS NULL AND irrigation_zone_id = ? ORDER BY deveui ASC', [zone.id]);
      const cards = deriveCardsForZone(zone, devices);
      for (const card of cards) {
        const sourceDevices = sourceDevicesForCard(card, devices)
          .slice()
          .sort((left, right) =>
            String(normalizeDeveui(left.deveui || left.device_eui) || '').localeCompare(String(normalizeDeveui(right.deveui || right.device_eui) || ''))
          );
        sourceDevices.forEach((device, index) => {
          const deveui = normalizeDeveui(device.deveui || device.device_eui || device.deviceEui);
          const sourceKey = sourceKeyForCsv(card, device);
          if (!deveui || !sourceKey) return;
          const deviceName = displayDeviceName(device, index);
          for (const channelKey of cardChannelsForSource(card.cardType, displaySafeDeviceContext(device))) {
            const meta = channelMeta(channelKey);
            const seriesId = analysisSeriesId(zone.id, card.cardType, sourceKey, channelKey);
            const entry = {
              seriesId,
              hubEui,
              zoneId: zone.id,
              zoneName: zone.name || null,
              cardType: card.cardType,
              sourceKey,
              channelKey,
              displayName: [deviceName, meta.label].filter(Boolean).join(' - '),
              unit: meta.unit,
              availability: meta.edgeField ? 'available' : 'unsupported',
              deviceName,
              depthCm: soilDepthCm(device, channelKey),
            };
            channels.push(entry);
            entriesById.set(seriesId, { ...entry, deveui });
          }
        });
      }
    }

    return { generatedAt: new Date().toISOString(), channels, entriesById };
  }

  return {
    analysisSeriesId,
    buildAnalysisCatalog,
  };
}

module.exports = {
  analysisSeriesId,
  createAnalysis,
};
