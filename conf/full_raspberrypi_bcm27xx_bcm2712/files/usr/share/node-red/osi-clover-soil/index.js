'use strict';

const MOISTURE_RECORD = 0x0104;
const TEMPERATURE_RECORD = 0x0202;

// TEKTELIC T0005978 TRM v2.1, §2.1 Table 3. Walk complete records so bytes
// inside another transducer's value cannot be mistaken for a soil header.
const RECORD_LENGTHS = {
  0x00BA: 1, 0x00FF: 1, 0x00D3: 1, 0x00BD: 2, // Battery (0x00FF is legacy).
  [MOISTURE_RECORD]: 2, [TEMPERATURE_RECORD]: 2,
  0x0302: 2, 0x0367: 2, 0x0402: 2, 0x0467: 2, 0x0504: 2, 0x0604: 2, // KIWI.
  0x0965: 2, 0x0900: 1, 0x0A71: 6, 0x0A00: 1, 0x0B67: 2, 0x0B68: 1, 0x0C67: 2,
};

// Table 4 establishes the domain. The vendor codec includes each shared
// endpoint in the wetter bin. The exclusive lower limits start with Dry
// and continue from 0.1 through 1.2 grams of water per gram of dry soil.
const MIN_FREQUENCY_KHZ = 1322;
const MAX_FREQUENCY_KHZ = 1402;
const GWC_LOWER_LIMITS_KHZ = [1399, 1396, 1391, 1386, 1381, 1376, 1371, 1366, 1361, 1356, 1351, 1346, 1341];
const WATER_DENSITY_G_CM3 = 1;

// Call for a known surface-mount CLOVER. The return value distinguishes an
// unusable frame (ok: false) from an absent or invalid individual measurement.
function decodeSoilUplink(input) {
  if (input?.fPort !== 10) return { ok: false, error: 'unsupported_fport' };
  const { bytes } = input;
  if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) {
    return { ok: false, error: 'invalid_bytes' };
  }
  for (const byte of bytes) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      return { ok: false, error: 'invalid_bytes' };
    }
  }

  let frequencyKHz = null;
  let voltageMv = null;
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 2 > bytes.length) return { ok: false, error: 'truncated_header' };
    const header = (bytes[offset] << 8) | bytes[offset + 1];
    const length = RECORD_LENGTHS[header];
    if (length === undefined) return { ok: false, error: 'unknown_record' };
    const valueOffset = offset + 2;
    offset = valueOffset + length;
    if (offset > bytes.length) return { ok: false, error: 'truncated_record' };

    if (header === MOISTURE_RECORD) {
      if (frequencyKHz !== null) return { ok: false, error: 'duplicate_soil_record' };
      frequencyKHz = (bytes[valueOffset] << 8) | bytes[valueOffset + 1];
    } else if (header === TEMPERATURE_RECORD) {
      if (voltageMv !== null) return { ok: false, error: 'duplicate_soil_record' };
      voltageMv = (bytes[valueOffset] << 8) | bytes[valueOffset + 1];
    }
  }

  let gwcMassRatio = null;
  let moistureCategory = null;
  let soilTemperatureC = null;
  const errors = [];

  if (frequencyKHz !== null) {
    if (frequencyKHz < MIN_FREQUENCY_KHZ || frequencyKHz > MAX_FREQUENCY_KHZ) {
      errors.push('frequency_out_of_range');
    } else {
      const bin = GWC_LOWER_LIMITS_KHZ.findIndex((lower) => frequencyKHz > lower);
      if (bin === -1) moistureCategory = 'Wet';
      else if (bin === 0) moistureCategory = 'Dry';
      else gwcMassRatio = bin / 10;
    }
  }

  if (voltageMv === 0) {
    errors.push('zero_voltage');
  } else if (voltageMv !== null) {
    // §2.2.2 uses ln(volts × 1000). The unsigned wire count is already in mV.
    soilTemperatureC = 236.36 - 32.46 * Math.log(voltageMv);
  }

  return { ok: true, frequencyKHz, voltageMv, gwcMassRatio, moistureCategory, soilTemperatureC, errors };
}

// TEKTELIC CLOVER/KIWI FAQ: VWC = GWC × dry bulk density / water density.
// Densities are in g/cm³, using nominal water density. Return percent.
function deriveVwcPercent(gwcMassRatio, dryBulkDensityGcm3) {
  if (!Number.isFinite(gwcMassRatio) || gwcMassRatio < 0 ||
      !Number.isFinite(dryBulkDensityGcm3) || dryBulkDensityGcm3 <= 0) {
    return null;
  }
  const percent = gwcMassRatio * (dryBulkDensityGcm3 / WATER_DENSITY_G_CM3) * 100;
  return Number.isFinite(percent) ? percent : null;
}

module.exports = { decodeSoilUplink, deriveVwcPercent };
