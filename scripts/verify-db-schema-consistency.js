#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const seedDatabasePaths = [
  'conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db',
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
    'swt_1',
    'swt_2',
    'swt_3',
    'payload_b64',
    'f_port',
    'f_cnt',
    'calibration_status',
    'data_invalid',
    'comp_pending',
    'created_at',
  ],
  chameleon_calibrations: [
    'array_id', 'sensor_id',
    'sensor1_a', 'sensor1_b', 'sensor1_c', 'sensor1_r2',
    'sensor2_a', 'sensor2_b', 'sensor2_c', 'sensor2_r2',
    'sensor3_a', 'sensor3_b', 'sensor3_c', 'sensor3_r2',
    'test_rig_run_start_date', 'source', 'fetched_at',
  ],
  chameleon_calibration_misses: [
    'array_id', 'last_tried', 'reason',
  ],
  zone_seasons: [
    'id',
    'zone_id',
    'season_uuid',
    'name',
    'starts_on',
    'ends_on',
    'crop_type',
    'variety',
    'phenological_stage',
    'is_active',
    'is_default',
    'created_at',
    'updated_at',
  ],
  sync_link_state: [
    'peer_node',
    'linked',
    'server_url',
    'cloud_user_id',
    'gateway_device_eui',
    'updated_at',
  ],
  history_channel_rollups: [
    'id',
    'zone_id',
    'card_type',
    'logical_source_key',
    'channel_id',
    'bucket_level',
    'bucket_start',
    'bucket_end',
    'min_value',
    'max_value',
    'mean_value',
    'median_value',
    'latest_value',
    'dominant_status',
    'coverage_pct',
    'coverage_confidence',
    'sample_count',
    'event_count',
    'threshold_crossing_count',
    'unit',
    'computed_at',
  ],
  history_card_preferences: [
    'user_id',
    'owner_user_uuid',
    'scope_type',
    'zone_id',
    'gateway_eui',
    'card_id',
    'pinned',
    'manual_order',
    'open_count',
    'last_opened_at',
    'last_view_mode',
    'hidden',
    'updated_at',
  ],
  history_workspaces: [
    'id',
    'user_id',
    'owner_user_uuid',
    'zone_id',
    'name',
    'workspace_json',
    'is_default',
    'created_at',
    'updated_at',
  ],
};

const requiredIndexes = {
  device_data: ['idx_device_data_deveui_recorded_at'],
  dendrometer_readings: ['idx_dendro_readings_deveui_time'],
  chameleon_readings: ['idx_chameleon_readings_deveui_time', 'idx_chameleon_readings_array_id'],
  chameleon_calibrations: ['idx_chameleon_calibrations_sensor_id'],
  zone_seasons: [
    'idx_zone_seasons_zone_range',
    'idx_zone_seasons_zone_active',
    'idx_zone_seasons_zone_active_unique',
    'idx_zone_seasons_zone_default',
    'idx_zone_seasons_uuid',
  ],
  history_channel_rollups: [
    'idx_history_rollups_zone_card_bucket',
    'idx_history_rollups_source_channel',
    'idx_history_rollups_unique_bucket',
  ],
  history_card_preferences: [
    'idx_history_card_preferences_zone',
    'idx_history_card_preferences_gateway',
  ],
  history_workspaces: [
    'idx_history_workspaces_user_zone',
    'idx_history_workspaces_user_default',
    'idx_history_workspaces_user_global_default',
  ],
};

const requiredIndexSqlFragments = {
  idx_device_data_deveui_recorded_at: [
    'on device_data(deveui, recorded_at)',
  ],
  idx_zone_seasons_zone_range: [
    'on zone_seasons(zone_id, starts_on, ends_on)',
  ],
  idx_zone_seasons_zone_active: [
    'on zone_seasons(zone_id, is_active, starts_on, ends_on)',
  ],
  idx_zone_seasons_zone_active_unique: [
    'unique index',
    'on zone_seasons(zone_id)',
    'where is_active = 1',
  ],
  idx_zone_seasons_zone_default: [
    'unique index',
    'on zone_seasons(zone_id)',
    'where is_default = 1',
  ],
  idx_zone_seasons_uuid: [
    'unique index',
    'on zone_seasons(season_uuid)',
    'where season_uuid is not null',
  ],
  idx_history_rollups_unique_bucket: [
    'unique index',
    'on history_channel_rollups(zone_id, card_type, logical_source_key, channel_id, bucket_level, bucket_start)',
  ],
  idx_history_rollups_zone_card_bucket: [
    'on history_channel_rollups(zone_id, card_type, bucket_level, bucket_start, bucket_end)',
  ],
  idx_history_rollups_source_channel: [
    'on history_channel_rollups(logical_source_key, channel_id, bucket_level, bucket_start)',
  ],
  idx_history_card_preferences_zone: [
    'unique index',
    'on history_card_preferences(user_id, zone_id, card_id)',
    "where scope_type = 'zone'",
  ],
  idx_history_card_preferences_gateway: [
    'unique index',
    'on history_card_preferences(user_id, gateway_eui, card_id)',
    "where scope_type = 'gateway'",
  ],
  idx_history_workspaces_user_zone: [
    'on history_workspaces(user_id, zone_id)',
  ],
  idx_history_workspaces_user_default: [
    'unique index',
    'on history_workspaces(user_id, zone_id)',
    'where is_default = 1',
  ],
  idx_history_workspaces_user_global_default: [
    'unique index',
    'on history_workspaces(user_id)',
    'where is_default = 1 and zone_id is null',
  ],
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

function indexSql(dbPath, indexName) {
  const escapedName = indexName.replace(/'/g, "''");
  return sqlite(dbPath, `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '${escapedName}';`);
}

function tableSql(dbPath, tableName) {
  const escapedName = tableName.replace(/'/g, "''");
  return sqlite(dbPath, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${escapedName}';`);
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
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
  if (!tableSql(dbPath, 'devices').includes("'AQUASCOPE_LORAIN'")) {
    throw new Error(`${dbPath}: devices.type_id CHECK is missing AQUASCOPE_LORAIN`);
  }
  for (const [tableName, expectedIndexes] of Object.entries(requiredIndexes)) {
    const indexes = indexNames(dbPath, tableName);
    const missing = expectedIndexes.filter((name) => !indexes.includes(name));
    if (missing.length) {
      throw new Error(`${dbPath}:${tableName} missing indexes: ${missing.join(',')}`);
    }
  }
  for (const [indexName, expectedFragments] of Object.entries(requiredIndexSqlFragments)) {
    const sql = normalizeSql(indexSql(dbPath, indexName));
    const missingFragments = expectedFragments.filter((fragment) => !sql.includes(fragment));
    if (missingFragments.length) {
      throw new Error(`${dbPath}:${indexName} definition drift: ${sql || '<missing>'}`);
    }
  }
  const historyQueryPlan = sqlite(
    dbPath,
    `EXPLAIN QUERY PLAN
     SELECT *
     FROM device_data
     WHERE deveui IN ('0016C001F11715E2', '0016C001F11715E3', '0016C001F11715E4')
       AND recorded_at BETWEEN '2026-01-01T00:00:00Z' AND '2026-01-31T23:59:59Z';`,
  );
  if (!historyQueryPlan.includes('idx_device_data_deveui_recorded_at')) {
    throw new Error(`${dbPath}: history raw query did not use idx_device_data_deveui_recorded_at: ${historyQueryPlan}`);
  }
}

const explicitPaths = process.argv.slice(2);
const dbPaths = explicitPaths.length ? explicitPaths.map((entry) => path.resolve(entry)) : seedDatabasePaths;

const seedSqlPath = path.join(repoRoot, 'database', 'seed-blank.sql');
const seedSql = fs.readFileSync(seedSqlPath, 'utf8');
if (!seedSql.includes("'AQUASCOPE_LORAIN'")) {
  throw new Error(`${path.relative(repoRoot, seedSqlPath)}: devices.type_id CHECK is missing AQUASCOPE_LORAIN`);
}

for (const dbPath of dbPaths) {
  verifyDb(dbPath);
  console.log(`OK ${path.relative(repoRoot, dbPath) || dbPath}`);
}

console.log('DB schema consistency verification passed');
