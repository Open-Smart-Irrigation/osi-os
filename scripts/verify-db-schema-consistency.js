#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const seedDatabasePaths = [
  'conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db',
  'database/farming.db',
  'web/react-gui/farming.db',
].map((relativePath) => path.join(repoRoot, relativePath));

const schemaContract = {
  devices: [
    'id',
    'deveui',
    'name',
    'type_id',
    'user_id',
    'farm_id',
    'current_state',
    'target_state',
    'created_at',
    'updated_at',
    'claimed_at',
    'chirpstack_app_id',
    'irrigation_zone_id',
    'dendro_enabled',
    'temp_enabled',
    'is_reference_tree',
    'sync_version',
    'deleted_at',
    'gateway_device_eui',
    'strega_model',
    'rain_gauge_enabled',
    'flow_meter_enabled',
    'soil_moisture_probe_depths_json',
    'soil_moisture_probe_depths_configured',
    'dendro_force_legacy',
    'dendro_stroke_mm',
    'dendro_ratio_at_retracted',
    'dendro_ratio_at_extended',
    'dendro_ratio_zero',
    'dendro_ratio_span',
    'dendro_baseline_position_mm',
    'dendro_baseline_mode_used',
    'dendro_baseline_calibration_signature',
    'dendro_baseline_pending',
    'dendro_invert_direction',
    'chameleon_enabled',
    'chameleon_swt1_depth_cm',
    'chameleon_swt2_depth_cm',
    'chameleon_swt3_depth_cm',
    'chameleon_swt1_a',
    'chameleon_swt1_b',
    'chameleon_swt1_c',
    'chameleon_swt2_a',
    'chameleon_swt2_b',
    'chameleon_swt2_c',
    'chameleon_swt3_a',
    'chameleon_swt3_b',
    'chameleon_swt3_c',
    'device_mode',
  ],
  device_data: [
    'id',
    'deveui',
    'swt_wm1',
    'swt_wm2',
    'light_lux',
    'recorded_at',
    'ambient_temperature',
    'relative_humidity',
    'ext_temperature_c',
    'bat_v',
    'adc_ch0v',
    'dendro_position_mm',
    'dendro_valid',
    'dendro_delta_mm',
    'rain_count_cumulative',
    'rain_tips_delta',
    'rain_mm_delta',
    'flow_count_cumulative',
    'flow_pulses_delta',
    'flow_liters_delta',
    'swt_1',
    'swt_2',
    'swt_3',
    'lsn50_mode_code',
    'lsn50_mode_label',
    'lsn50_mode_observed_at',
    'rain_mm_per_hour',
    'rain_delta_status',
    'flow_liters_per_min',
    'flow_delta_status',
    'counter_interval_seconds',
    'rain_mm_per_10min',
    'rain_mm_today',
    'flow_liters_per_10min',
    'flow_liters_today',
    'barometric_pressure_hpa',
    'wind_speed_mps',
    'wind_direction_deg',
    'wind_gust_mps',
    'uv_index',
    'rain_gauge_cumulative_mm',
    'bat_pct',
    'adc_ch1v',
    'dendro_ratio',
    'dendro_mode_used',
    'dendro_stem_change_um',
    'dendro_position_raw_mm',
    'dendro_saturated',
    'dendro_saturation_side',
  ],
  dendrometer_readings: [
    'id',
    'deveui',
    'position_um',
    'adc_v',
    'bat_v',
    'is_valid',
    'invalid_reason',
    'is_outlier',
    'recorded_at',
    'adc_ch0v',
    'adc_ch1v',
    'dendro_ratio',
    'dendro_mode_used',
    'position_raw_um',
    'dendro_saturated',
    'dendro_saturation_side',
  ],
  chameleon_readings: [
    'id',
    'deveui',
    'recorded_at',
    'payload_version',
    'status_flags',
    'i2c_missing',
    'timeout',
    'temp_fault',
    'id_fault',
    'ch1_open',
    'ch2_open',
    'ch3_open',
    'temp_c',
    'r1_ohm_comp',
    'r2_ohm_comp',
    'r3_ohm_comp',
    'r1_ohm_raw',
    'r2_ohm_raw',
    'r3_ohm_raw',
    'array_id',
    'adc_ch0v',
    'adc_ch1v',
    'adc_ch4v',
    'bat_v',
    'payload_b64',
    'f_port',
    'f_cnt',
    'created_at',
  ],
};

const requiredIndexes = {
  dendrometer_readings: ['idx_dendro_readings_deveui_time'],
  chameleon_readings: ['idx_chameleon_readings_deveui_time', 'idx_chameleon_readings_array_id'],
};

function sqlite(dbPath, sql) {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

function columnNames(dbPath, tableName) {
  const output = sqlite(dbPath, `PRAGMA table_info(${tableName});`);
  if (!output) return [];
  return output.split('\n').map((line) => line.split('|')[1]).filter(Boolean);
}

function indexNames(dbPath, tableName) {
  const output = sqlite(dbPath, `PRAGMA index_list(${tableName});`);
  if (!output) return [];
  return output.split('\n').map((line) => line.split('|')[1]).filter(Boolean);
}

function compareSet(label, actualValues, expectedValues) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  const missing = expectedValues.filter((name) => !actual.has(name));
  const extra = actualValues.filter((name) => !expected.has(name));
  if (missing.length || extra.length) {
    throw new Error(
      `${label} drift: missing=[${missing.join(',') || '-'}] extra=[${extra.join(',') || '-'}]`,
    );
  }
}

function verifyDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`database not found: ${dbPath}`);
  }
  const integrity = sqlite(dbPath, 'PRAGMA integrity_check;');
  if (integrity !== 'ok') {
    throw new Error(`${dbPath} integrity_check failed: ${integrity}`);
  }
  for (const [tableName, expectedColumns] of Object.entries(schemaContract)) {
    compareSet(`${dbPath}:${tableName} columns`, columnNames(dbPath, tableName), expectedColumns);
  }
  for (const [tableName, expectedIndexes] of Object.entries(requiredIndexes)) {
    const indexes = indexNames(dbPath, tableName);
    const missing = expectedIndexes.filter((name) => !indexes.includes(name));
    if (missing.length) {
      throw new Error(`${dbPath}:${tableName} missing indexes: ${missing.join(',')}`);
    }
  }
}

const explicitPaths = process.argv.slice(2);
const dbPaths = explicitPaths.length ? explicitPaths.map((entry) => path.resolve(entry)) : seedDatabasePaths;

for (const dbPath of dbPaths) {
  verifyDb(dbPath);
  console.log(`OK ${path.relative(repoRoot, dbPath) || dbPath}`);
}

console.log('DB schema consistency verification passed');
