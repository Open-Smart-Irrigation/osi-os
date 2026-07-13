-- risk: additive
-- 0015: Per-row sync versioning for the daily-analytics upsert aggregates
-- (osi-os fresh-Pi verification 2026-07-13, issue #10). The cloud
-- SyncEventTxExecutor keeps a per-resource watermark (highest sync_version +
-- payload hash) and terminally rejects an equal-version-different-payload
-- event. The dendrometer_daily / zone_daily_recommendations /
-- zone_daily_environment outbox triggers passed literal 0 on every INSERT and
-- UPDATE while payloads embed computed_at, so the first delivery pinned
-- version 0 and every recompute was rejected (equal_version_payload_conflict).
-- Fix: add a sync_version column to the three aggregate tables (writers bump
-- it on every rewrite) and recreate the six outbox triggers to pass
-- NEW.sync_version, mirror it into payload_json (devices/zones precedent), and
-- gate the AFTER UPDATE triggers on a sync_version change.
-- Each trigger below is dropped and recreated verbatim from
-- database/seed-blank.sql so that replaying 0001..0015 reproduces the seed
-- schema exactly (see scripts/verify-seed-replay.js; 0003 precedent).

ALTER TABLE dendrometer_daily ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zone_daily_recommendations ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE zone_daily_environment ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS trg_dp_dendro_daily_outbox_ai;
CREATE TRIGGER trg_dp_dendro_daily_outbox_ai
AFTER INSERT ON dendrometer_daily
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'DENDRO_DAILY',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.date,''),
    'DENDRO_DAILY_UPSERTED',
    json_object(
      'contract_version', 1,
      'device_eui',            NEW.deveui,
      'zone_id',               (SELECT irrigation_zone_id FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      'zone_uuid',             (SELECT iz.zone_uuid FROM devices d LEFT JOIN irrigation_zones iz ON iz.id=d.irrigation_zone_id AND iz.deleted_at IS NULL WHERE d.deveui=NEW.deveui AND d.deleted_at IS NULL),
      'gateway_device_eui',    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2'),
      'date',                  NEW.date,
      'd_max_um',              NEW.d_max_um,
      'd_min_um',              NEW.d_min_um,
      'mds_um',                NEW.mds_um,
      'tgr_um',                NEW.tgr_um,
      'tgr_smoothed_um',       NEW.tgr_smoothed_um,
      'twd_um',                NEW.twd_um,
      'dr_um',                 NEW.dr_um,
      'recovery_delta_um',     NEW.recovery_delta_um,
      'signal_intensity',      NEW.signal_intensity,
      'stress_level',          NEW.stress_level,
      'data_quality',          NEW.data_quality,
      'valid_readings_count',  NEW.valid_readings_count,
      'd_max_time',            NEW.d_max_time,
      'd_min_time',            NEW.d_min_time,
      'twd_night_um',          NEW.twd_night_um,
      'twd_day_um',            NEW.twd_day_um,
      'twd_norm_night',        NEW.twd_norm_night,
      'twd_norm_day',          NEW.twd_norm_day,
      'mds_norm',              NEW.mds_norm,
      'recovery_ratio',        NEW.recovery_ratio,
      'recovery_ratio_smoothed', NEW.recovery_ratio_smoothed,
      'r_delta_5day',          NEW.r_delta_5day,
      'delta_twd_smoothed',    NEW.delta_twd_smoothed,
      'd_max_running_um',      NEW.d_max_running_um,
      'twd_episode_active',    NEW.twd_episode_active,
      'twd_episode_start',     NEW.twd_episode_start,
      'twd_episode_max_um',    NEW.twd_episode_max_um,
      'envelope_ref_um',       NEW.envelope_ref_um,
      'twd_method',            NEW.twd_method,
      'confidence_score',      NEW.confidence_score,
      'qa_flags_json',         NEW.qa_flags_json,
      'low_confidence_day',    NEW.low_confidence_day,
      'tree_state_v5',         NEW.tree_state_v5,
      'computed_at',           NEW.computed_at,
      'sync_version',          NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;
DROP TRIGGER IF EXISTS trg_dp_dendro_daily_outbox_au;
CREATE TRIGGER trg_dp_dendro_daily_outbox_au
AFTER UPDATE ON dendrometer_daily
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
 AND COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'DENDRO_DAILY',
    COALESCE(NEW.deveui,'') || '|' || COALESCE(NEW.date,''),
    'DENDRO_DAILY_UPSERTED',
    json_object(
      'contract_version', 1,
      'device_eui',            NEW.deveui,
      'zone_id',               (SELECT irrigation_zone_id FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),
      'zone_uuid',             (SELECT iz.zone_uuid FROM devices d LEFT JOIN irrigation_zones iz ON iz.id=d.irrigation_zone_id AND iz.deleted_at IS NULL WHERE d.deveui=NEW.deveui AND d.deleted_at IS NULL),
      'gateway_device_eui',    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2'),
      'date',                  NEW.date,
      'd_max_um',              NEW.d_max_um,
      'd_min_um',              NEW.d_min_um,
      'mds_um',                NEW.mds_um,
      'tgr_um',                NEW.tgr_um,
      'tgr_smoothed_um',       NEW.tgr_smoothed_um,
      'twd_um',                NEW.twd_um,
      'dr_um',                 NEW.dr_um,
      'recovery_delta_um',     NEW.recovery_delta_um,
      'signal_intensity',      NEW.signal_intensity,
      'stress_level',          NEW.stress_level,
      'data_quality',          NEW.data_quality,
      'valid_readings_count',  NEW.valid_readings_count,
      'd_max_time',            NEW.d_max_time,
      'd_min_time',            NEW.d_min_time,
      'twd_night_um',          NEW.twd_night_um,
      'twd_day_um',            NEW.twd_day_um,
      'twd_norm_night',        NEW.twd_norm_night,
      'twd_norm_day',          NEW.twd_norm_day,
      'mds_norm',              NEW.mds_norm,
      'recovery_ratio',        NEW.recovery_ratio,
      'recovery_ratio_smoothed', NEW.recovery_ratio_smoothed,
      'r_delta_5day',          NEW.r_delta_5day,
      'delta_twd_smoothed',    NEW.delta_twd_smoothed,
      'd_max_running_um',      NEW.d_max_running_um,
      'twd_episode_active',    NEW.twd_episode_active,
      'twd_episode_start',     NEW.twd_episode_start,
      'twd_episode_max_um',    NEW.twd_episode_max_um,
      'envelope_ref_um',       NEW.envelope_ref_um,
      'twd_method',            NEW.twd_method,
      'confidence_score',      NEW.confidence_score,
      'qa_flags_json',         NEW.qa_flags_json,
      'low_confidence_day',    NEW.low_confidence_day,
      'tree_state_v5',         NEW.tree_state_v5,
      'computed_at',           NEW.computed_at,
      'sync_version',          NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM devices WHERE deveui=NEW.deveui AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;
DROP TRIGGER IF EXISTS trg_dp_zone_env_outbox_ai;
CREATE TRIGGER trg_dp_zone_env_outbox_ai
AFTER INSERT ON zone_daily_environment
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_ENVIRONMENT',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'') || '|' || COALESCE(NEW.date,''),
    'ZONE_ENVIRONMENT_APPENDED',
    json_object(
      'contract_version', 1,
      'zone_id',            NEW.zone_id,
      'zone_uuid',          (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',               NEW.date,
      'rainfall_mm',        NEW.rainfall_mm,
      'flow_liters',        NEW.flow_liters,
      'rain_source',        NEW.rain_source,
      'computed_at',        NEW.computed_at,
      'gateway_device_eui', COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2'),
      'sync_version',       NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;
DROP TRIGGER IF EXISTS trg_dp_zone_env_outbox_au;
CREATE TRIGGER trg_dp_zone_env_outbox_au
AFTER UPDATE ON zone_daily_environment
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
 AND COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_ENVIRONMENT',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'') || '|' || COALESCE(NEW.date,''),
    'ZONE_ENVIRONMENT_APPENDED',
    json_object(
      'contract_version', 1,
      'zone_id',            NEW.zone_id,
      'zone_uuid',          (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',               NEW.date,
      'rainfall_mm',        NEW.rainfall_mm,
      'flow_liters',        NEW.flow_liters,
      'rain_source',        NEW.rain_source,
      'computed_at',        NEW.computed_at,
      'gateway_device_eui', COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2'),
      'sync_version',       NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;
DROP TRIGGER IF EXISTS trg_dp_zone_recs_outbox_ai;
CREATE TRIGGER trg_dp_zone_recs_outbox_ai
AFTER INSERT ON zone_daily_recommendations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_RECOMMENDATION',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'') || '|' || COALESCE(NEW.date,''),
    'ZONE_RECOMMENDATION_UPSERTED',
    json_object(
      'contract_version', 1,
      'zone_id',                       NEW.zone_id,
      'zone_uuid',                     (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',                          NEW.date,
      'gateway_device_eui',            COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2'),
      'zone_stress_summary',           NEW.zone_stress_summary,
      'rainfall_mm',                   NEW.rainfall_mm,
      'water_delivered_liters',        NEW.water_delivered_liters,
      'irrigation_action',             NEW.irrigation_action,
      'action_reasoning',              NEW.action_reasoning,
      'recommendation_json',           NEW.recommendation_json,
      'rain_suppression_active',       NEW.rain_suppression_active,
      'recovery_verification_active',  NEW.recovery_verification_active,
      'vpd_max_kpa',                   NEW.vpd_max_kpa,
      'vpd_source',                    NEW.vpd_source,
      'irrigation_window_json',        NEW.irrigation_window_json,
      'usable_tree_count',             NEW.usable_tree_count,
      'low_confidence_tree_count',     NEW.low_confidence_tree_count,
      'outlier_filtered_tree_count',   NEW.outlier_filtered_tree_count,
      'zone_confidence_score',         NEW.zone_confidence_score,
      'computed_at',                   NEW.computed_at,
      'sync_version',                  NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;
DROP TRIGGER IF EXISTS trg_dp_zone_recs_outbox_au;
CREATE TRIGGER trg_dp_zone_recs_outbox_au
AFTER UPDATE ON zone_daily_recommendations
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM sync_link_state
   WHERE peer_node = 'cloud' AND linked = 1
)
 AND COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'ZONE_RECOMMENDATION',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'') || '|' || COALESCE(NEW.date,''),
    'ZONE_RECOMMENDATION_UPSERTED',
    json_object(
      'contract_version', 1,
      'zone_id',                       NEW.zone_id,
      'zone_uuid',                     (SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),
      'date',                          NEW.date,
      'gateway_device_eui',            COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2'),
      'zone_stress_summary',           NEW.zone_stress_summary,
      'rainfall_mm',                   NEW.rainfall_mm,
      'water_delivered_liters',        NEW.water_delivered_liters,
      'irrigation_action',             NEW.irrigation_action,
      'action_reasoning',              NEW.action_reasoning,
      'recommendation_json',           NEW.recommendation_json,
      'rain_suppression_active',       NEW.rain_suppression_active,
      'recovery_verification_active',  NEW.recovery_verification_active,
      'vpd_max_kpa',                   NEW.vpd_max_kpa,
      'vpd_source',                    NEW.vpd_source,
      'irrigation_window_json',        NEW.irrigation_window_json,
      'usable_tree_count',             NEW.usable_tree_count,
      'low_confidence_tree_count',     NEW.low_confidence_tree_count,
      'outlier_filtered_tree_count',   NEW.outlier_filtered_tree_count,
      'zone_confidence_score',         NEW.zone_confidence_score,
      'computed_at',                   NEW.computed_at,
      'sync_version',                  NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'0016C001F11715E2')
  );
END;
