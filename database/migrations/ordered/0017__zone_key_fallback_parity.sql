-- risk: additive
-- 0017: Zone aggregate_key fallback parity for zone_daily_environment /
-- zone_daily_recommendations outbox triggers (osi-os fresh-Pi verification
-- 2026-07-13, trigger-body parity adjudication, issue 16 Pattern B). The
-- migration-owned copies of these four triggers fell back to '' as the
-- sync_outbox aggregate_key zone component when a zone has no zone_uuid yet,
-- colliding aggregate keys ACROSS different uuid-less zones and corrupting the
-- cloud's per-resource watermark semantics. The sync-init-fn boot rewrite --
-- what every live gateway actually runs, since boot DDL wins at runtime --
-- falls back to 'zone-id:' || NEW.zone_id, keeping keys unique per zone; the
-- seed adopts that form (codifying existing production behavior). Each trigger
-- below is dropped and recreated verbatim from database/seed-blank.sql so that
-- replaying 0001..0017 reproduces the seed schema exactly (see
-- scripts/verify-seed-replay.js; 0003/0015/0016 precedent).

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
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'zone-id:' || NEW.zone_id) || '|' || COALESCE(NEW.date,''),
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
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'zone-id:' || NEW.zone_id) || '|' || COALESCE(NEW.date,''),
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
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'zone-id:' || NEW.zone_id) || '|' || COALESCE(NEW.date,''),
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
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id=NEW.zone_id AND deleted_at IS NULL),'zone-id:' || NEW.zone_id) || '|' || COALESCE(NEW.date,''),
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
