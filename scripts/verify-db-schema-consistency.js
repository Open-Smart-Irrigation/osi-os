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
    'valve_1_state',
    'valve_2_state',
    'valve_1_pulse',
    'valve_2_pulse',
    'pipe_pressure_kpa',
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
  analysis_views: [
    'id',
    'user_id',
    'owner_user_uuid',
    'name',
    'view_json',
    'is_default',
    'created_at',
    'updated_at',
  ],
  gateway_health_samples: [
    'id',
    'gateway_device_eui',
    'sampled_at',
    'cpu_temp_c',
    'mem_percent',
    'load_1',
    'load_5',
    'load_15',
    'fan_value',
    'throttled',
    'created_at',
  ],
  gateway_health_hourly: [
    'gateway_device_eui',
    'hour_start',
    'sample_count',
    'cpu_temp_c_min',
    'cpu_temp_c_mean',
    'cpu_temp_c_max',
    'mem_percent_min',
    'mem_percent_mean',
    'mem_percent_max',
    'load_1_min',
    'load_1_mean',
    'load_1_max',
    'load_5_min',
    'load_5_mean',
    'load_5_max',
    'load_15_min',
    'load_15_mean',
    'load_15_max',
    'fan_value_min',
    'fan_value_mean',
    'fan_value_max',
    'throttled_max',
    'computed_at',
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
  irrigation_events: [
    'id',
    'user_id',
    'irrigation_zone_id',
    'action',
    'reason',
    'aggregate_kpa',
    'threshold_kpa',
    'duration_minutes',
    'valve_deveui',
    'payload_json',
    'event_uuid',
    'created_at',
  ],
  sync_link_state: [
    'peer_node',
    'linked',
    'server_url',
    'cloud_user_id',
    'gateway_device_eui',
    'updated_at',
  ],
  sync_history_cursors: [
    'peer_node',
    'table_name',
    'state',
    'snapshot_high_id',
    'last_acked_id',
    'last_acked_key',
    'last_shadow_acked_id',
    'last_shadow_acked_key',
    'last_shadow_error',
    'backfill_started_at',
    'backfill_completed_at',
    'last_batch_id',
    'last_batch_at',
    'retry_count',
    'next_attempt_at',
    'last_error',
  ],
  sync_history_dirty_keys: [
    'peer_node',
    'table_name',
    'row_key',
    'change_kind',
    'source_row_id',
    'changed_at',
    'status',
    'attempts',
    'next_attempt_at',
    'last_error',
  ],
  sync_history_segments: [
    'peer_node',
    'table_name',
    'segment_key',
    'hash_version',
    'canonical_row_count',
    'syncable_row_count',
    'syncable_payload_hash',
    'quarantined_count',
    'covered_max_id',
    'computed_at',
  ],
  sync_history_quarantine: [
    'peer_node',
    'table_name',
    'history_key',
    'payload_hash',
    'reason',
    'first_seen_at',
    'last_seen_at',
    'attempts',
  ],
  improvement_requests: [
    'request_uuid',
    'user_id',
    'type',
    'title',
    'contact_email',
    'description',
    'expected',
    'actual',
    'steps',
    'area',
    'severity',
    'consent_diagnostics',
    'consent_public',
    'diagnostics_json',
    'gateway_device_eui',
    'local_status',
    'cloud_status',
    'cloud_reason',
    'cloud_human_message',
    'released_version',
    'submitted_at',
    'last_status_at',
    'created_at',
    'updated_at',
    'sync_version',
  ],
  ingest_quarantine: [
    'id',
    'deveui',
    'channel',
    'reason',
    'raw_value',
    'received_at',
  ],
  zone_valve_assignments: [
    'id',
    'zone_id',
    'deveui',
    'valve_channel',
    'created_at',
  ],
  lsn50_shadow_diff: [
    'id',
    'deveui',
    'recorded_at',
    'field',
    'old_value',
    'new_value',
    'diff_type',
    'created_at',
  ],
  journal_entries: [
    'id',
    'entry_uuid',
    'owner_user_uuid',
    'user_id',
    'author_principal_uuid',
    'author_label',
    'plot_uuid',
    'zone_id',
    'zone_uuid',
    'device_eui',
    'season_uuid',
    'season_crop',
    'season_variety',
    'campaign_uuid',
    'protocol_code',
    'protocol_version',
    'observation_unit_code',
    'pass_uuid',
    'batch_uuid',
    'activity_code',
    'template_code',
    'template_version',
    'layout_code',
    'layout_version',
    'catalog_version',
    'occurred_start',
    'occurred_end',
    'occurred_timezone',
    'occurred_utc_offset_minutes',
    'recorded_at',
    'origin',
    'status',
    'voided_at',
    'voided_by_principal_uuid',
    'void_reason',
    'note',
    'context_json',
    'sync_version',
    'gateway_device_eui',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  journal_entry_values: [
    'id',
    'entry_uuid',
    'attribute_code',
    'group_index',
    'value_status',
    'value_num',
    'value_text',
    'unit_code',
    'entered_value_num',
    'entered_unit_code',
  ],
  journal_vocab: [
    'code',
    'kind',
    'parent_code',
    'value_type',
    'quantity_kind',
    'basis',
    'default_unit_code',
    'labels_json',
    'icon_key',
    'constraints_json',
    'agrovoc_uri',
    'icasa_code',
    'adapt_code',
    'scope',
    'owner_user_uuid',
    'gateway_device_eui',
    'custom_field_uuid',
    'active',
    'sort_order',
    'sync_version',
    'created_at',
    'deleted_at',
  ],
  journal_vocab_mappings: [
    'id',
    'term_code',
    'scheme_uri',
    'scheme_version',
    'mapping_role',
    'external_id',
    'external_parent_id',
    'mapping_relation',
    'source_uri',
    'active',
  ],
  journal_templates: [
    'code',
    'version',
    'labels_json',
    'definition_json',
    'active',
  ],
  journal_layouts: [
    'code',
    'version',
    'labels_json',
    'definition_json',
    'active',
  ],
  journal_plots: [
    'plot_uuid',
    'plot_code',
    'name',
    'zone_uuid',
    'station_code',
    'crop_hint',
    'area_m2',
    'active',
    'sync_version',
    'gateway_device_eui',
    'created_at',
    'updated_at',
    'deleted_at',
    'owner_user_uuid',
  ],
  journal_plot_groups: [
    'group_uuid',
    'label',
    'gateway_device_eui',
    'created_by_principal_uuid',
    'created_at',
    'resolved_at',
    'resolved_by_principal_uuid',
    'sync_version',
    'deleted_at',
    'owner_user_uuid',
  ],
  journal_plot_group_members: [
    'group_uuid',
    'plot_uuid',
  ],
  journal_plot_settings: [
    'plot_uuid',
    'layout_code',
    'updated_at',
    'updated_by_principal_uuid',
    'sync_version',
  ],
  journal_products: [
    'product_uuid',
    'scope',
    'owner_user_uuid',
    'gateway_device_eui',
    'name',
    'kind',
    'composition_json',
    'active',
    'sync_version',
    'created_at',
    'deleted_at',
  ],
  journal_attachments: [
    'attachment_uuid',
    'entry_uuid',
    'kind',
    'original_filename',
    'mime',
    'size_bytes',
    'sha256',
    'blob_uuid',
    'local_relpath',
    'remote_object_key',
    'transfer_state',
    'captured_at',
    'sync_version',
    'created_at',
    'deleted_at',
  ],
  journal_catalog_state: [
    'id',
    'catalog_version',
    'catalog_hash',
    'updated_at',
  ],
};

const requiredIndexes = {
  device_data: ['idx_device_data_deveui_recorded_at'],
  dendrometer_readings: ['idx_dendro_readings_deveui_time'],
  chameleon_readings: ['idx_chameleon_readings_deveui_time', 'idx_chameleon_readings_array_id'],
  chameleon_calibrations: ['idx_chameleon_calibrations_sensor_id'],
  gateway_health_samples: ['idx_gateway_health_samples_eui_time', 'idx_gateway_health_samples_time'],
  gateway_health_hourly: ['idx_gateway_health_hourly_time'],
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
  irrigation_events: [
    'idx_irrig_events_user_created_at',
    'idx_irrig_events_zone_created_at',
    'idx_irrig_events_created_at',
    'idx_irrigation_events_zone_id',
    'idx_irrigation_events_event_uuid',
  ],
  improvement_requests: [
    'idx_improvement_requests_user_created_at',
    'idx_improvement_requests_status',
  ],
  ingest_quarantine: [
    'idx_ingest_quarantine_received',
  ],
  zone_valve_assignments: [
    'idx_zone_valve_zone',
    'idx_zone_valve_deveui',
  ],
  journal_entries: [
    'idx_journal_entries_zone_time',
    'idx_journal_entries_gateway_time',
    'idx_journal_entries_duplicate',
    'idx_journal_entries_sticky',
    'idx_journal_entries_plot_duplicate',
    'idx_journal_entries_plot_sticky',
  ],
  journal_entry_values: [
    'idx_journal_entry_values_entry',
  ],
  journal_attachments: [
    'idx_journal_attachments_entry',
  ],
  journal_plots: [
    'idx_journal_plots_owner_gateway',
  ],
  journal_plot_groups: [
    'idx_journal_plot_groups_owner_gateway',
  ],
};

const requiredIndexSqlFragments = {
  idx_device_data_deveui_recorded_at: [
    'on device_data(deveui, recorded_at)',
  ],
  idx_gateway_health_samples_eui_time: [
    'on gateway_health_samples(gateway_device_eui, sampled_at)',
  ],
  idx_gateway_health_samples_time: [
    'on gateway_health_samples(sampled_at)',
  ],
  idx_gateway_health_hourly_time: [
    'on gateway_health_hourly(hour_start)',
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
  idx_irrigation_events_event_uuid: [
    'unique index',
    'on irrigation_events(event_uuid)',
  ],
  idx_improvement_requests_user_created_at: [
    'on improvement_requests(user_id, created_at desc)',
  ],
  idx_improvement_requests_status: [
    'on improvement_requests(local_status, cloud_status, updated_at desc)',
  ],
  idx_ingest_quarantine_received: [
    'on ingest_quarantine(received_at)',
  ],
  idx_zone_valve_zone: [
    'on zone_valve_assignments(zone_id)',
  ],
  idx_zone_valve_deveui: [
    'on zone_valve_assignments(deveui)',
  ],
  idx_journal_entries_zone_time: [
    'on journal_entries(zone_id, occurred_start desc, entry_uuid)',
    'where deleted_at is null',
  ],
  idx_journal_entries_gateway_time: [
    'on journal_entries(gateway_device_eui, occurred_start desc, entry_uuid)',
    'where deleted_at is null',
  ],
  idx_journal_entries_duplicate: [
    'on journal_entries(zone_id, activity_code, occurred_start, entry_uuid)',
    "where status = 'final' and deleted_at is null",
  ],
  idx_journal_entries_sticky: [
    'on journal_entries(author_principal_uuid, zone_id, recorded_at desc, entry_uuid)',
    "where status = 'final' and deleted_at is null",
  ],
  idx_journal_entries_plot_duplicate: [
    'on journal_entries(plot_uuid, activity_code, occurred_start, entry_uuid)',
    "where status = 'final' and deleted_at is null",
  ],
  idx_journal_entries_plot_sticky: [
    'on journal_entries(author_principal_uuid, plot_uuid, recorded_at desc, entry_uuid)',
    "where status = 'final' and deleted_at is null",
  ],
  idx_journal_entry_values_entry: [
    'on journal_entry_values(entry_uuid)',
  ],
  idx_journal_attachments_entry: [
    'on journal_attachments(entry_uuid, deleted_at)',
  ],
  idx_journal_plots_owner_gateway: [
    'on journal_plots(owner_user_uuid, gateway_device_eui, deleted_at, zone_uuid, active)',
  ],
  idx_journal_plot_groups_owner_gateway: [
    'on journal_plot_groups(owner_user_uuid, gateway_device_eui, deleted_at, resolved_at)',
  ],
};

const requiredTriggerSqlFragments = {
  trg_sync_irrigation_events_uuid_ai: [
    'missing_gateway_device_eui',
    "where peer_node = 'cloud' and linked = 1",
    "nullif(trim(",
    'insert into sync_outbox',
    "aggregate_type='irrigation_event'",
    'not exists',
    "printf('%015d', new.id)",
  ],
  trg_dp_irrigation_events_outbox_ai: [
    'not exists',
    "aggregate_type='irrigation_event'",
    "aggregate_key=new.event_uuid",
  ],
  trg_dp_irrigation_events_outbox_au_event_uuid: [
    'not exists',
    "aggregate_type='irrigation_event'",
    "aggregate_key=new.event_uuid",
  ],
  trg_dp_chameleon_readings_outbox_ai: [
    "'data_invalid', coalesce(new.data_invalid,0)",
    "'comp_pending', coalesce(new.comp_pending,0)",
  ],
  trg_sync_device_data_dirty_au: [
    "select gateway_device_eui from devices where deveui = new.deveui",
    "<> '' begin",
  ],
  trg_sync_chameleon_readings_dirty_au: [
    "select gateway_device_eui from devices where deveui = new.deveui",
    "<> '' begin",
  ],
  trg_sync_dendro_readings_dirty_au: [
    "select gateway_device_eui from devices where deveui = new.deveui",
    "<> '' begin",
  ],
  trg_sync_zone_env_dirty_ai: [
    "'zone-id:' || new.zone_id",
  ],
  trg_sync_zone_env_dirty_au: [
    "'zone-id:' || new.zone_id",
  ],
  trg_sync_zone_recs_dirty_ai: [
    "'zone-id:' || new.zone_id",
  ],
  trg_sync_zone_recs_dirty_au: [
    "'zone-id:' || new.zone_id",
  ],
  trg_dp_dendro_readings_outbox_ai: [
    "nullif(trim(",
    "select gateway_device_eui from sync_link_state where peer_node = 'cloud'",
    "'gateway_device_eui', coalesce(nullif(trim(",
  ],
  trg_gateway_locations_outbox_ai: [
    "nullif(trim(new.gateway_device_eui)",
    "aggregate_key",
    "'gateway_device_eui', coalesce(nullif(trim(new.gateway_device_eui)",
  ],
  trg_gateway_locations_outbox_au: [
    "nullif(trim(new.gateway_device_eui)",
    "aggregate_key",
    "'gateway_device_eui', coalesce(nullif(trim(new.gateway_device_eui)",
  ],
  trg_improvement_requests_outbox_ai: [
    'work_request_submitted',
    'contract_version',
    "'schema_version', 1",
    "'request_id', new.request_uuid",
    "'type', new.type",
    "'title', new.title",
    "'contact_email', new.contact_email",
    "'description', new.description",
    "'area', new.area",
    "'severity', new.severity",
    "'consent_public'",
    "'consent_diagnostics'",
    "'diagnostics', json(new.diagnostics_json)",
    "'gateway_device_eui', new.gateway_device_eui",
    "'gui_user'",
    "'local_user_id', new.user_id",
    "'sync_version', new.sync_version",
    "'occurred_at', new.submitted_at",
    "'work-request-' || new.request_uuid",
  ],
};

const forbiddenTriggerSqlFragments = {
  trg_sync_irrigation_events_uuid_ai: [
    'randomblob(8)',
  ],
  trg_dp_dendro_readings_outbox_ai: [
    "'0016c001f11715e2'",
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

function triggerSql(dbPath, triggerName) {
  const escapedName = triggerName.replace(/'/g, "''");
  return sqlite(dbPath, `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = '${escapedName}';`);
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
  const scheduleSql = tableSql(dbPath, 'irrigation_schedules');
  for (const metric of ["'SWT_1'", "'SWT_2'", "'SWT_3'", "'DENDRO'"]) {
    if (!scheduleSql.includes(metric)) {
      throw new Error(`${dbPath}: irrigation_schedules.trigger_metric CHECK is missing ${metric}`);
    }
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
  for (const [triggerName, expectedFragments] of Object.entries(requiredTriggerSqlFragments)) {
    const sql = normalizeSql(triggerSql(dbPath, triggerName));
    const missingFragments = expectedFragments.filter((fragment) => !sql.includes(fragment));
    if (missingFragments.length) {
      throw new Error(`${dbPath}:${triggerName} definition drift: ${sql || '<missing>'}`);
    }
  }
  for (const [triggerName, forbiddenFragments] of Object.entries(forbiddenTriggerSqlFragments)) {
    const sql = normalizeSql(triggerSql(dbPath, triggerName));
    const presentFragments = forbiddenFragments.filter((fragment) => sql.includes(fragment));
    if (presentFragments.length) {
      throw new Error(`${dbPath}:${triggerName} contains forbidden trigger fragments: ${presentFragments.join(',')}`);
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
if (!seedSql.includes("CHECK (trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG','SWT_1','SWT_2','SWT_3','DENDRO'))")) {
  throw new Error(`${path.relative(repoRoot, seedSqlPath)}: irrigation_schedules.trigger_metric CHECK does not match the canonical 7-value vocabulary`);
}

for (const dbPath of dbPaths) {
  verifyDb(dbPath);
  console.log(`OK ${path.relative(repoRoot, dbPath) || dbPath}`);
}

console.log('DB schema consistency verification passed');
