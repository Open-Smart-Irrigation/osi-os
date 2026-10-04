-- risk: additive
-- 0068: WATERMARK calibration is an edge-authoritative retained resource.  The
-- calibration row (including its tombstone) is the only WATERMARK record that
-- enters sync_outbox; raw watermark_readings remain local diagnostics.
ALTER TABLE applied_commands ADD COLUMN binding_hash TEXT;
ALTER TABLE applied_commands ADD COLUMN intent_hash TEXT;
ALTER TABLE applied_commands ADD COLUMN resource_type TEXT;
ALTER TABLE applied_commands ADD COLUMN resource_id TEXT;
ALTER TABLE applied_commands ADD COLUMN gateway_device_eui TEXT;
ALTER TABLE applied_commands ADD COLUMN actor_user_uuid TEXT;
ALTER TABLE applied_commands ADD COLUMN base_sync_version INTEGER;
ALTER TABLE applied_commands ADD COLUMN operation TEXT;

CREATE INDEX idx_applied_commands_protected_effect
  ON applied_commands(effect_key, command_type, gateway_device_eui, resource_id, operation, intent_hash);

CREATE TRIGGER trg_watermark_calibrations_outbox_ai
AFTER INSERT ON watermark_calibrations FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND COALESCE(
    NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
    NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
  ) <> ''
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))), 'WATERMARK_CALIBRATION', upper(NEW.deveui),
    CASE WHEN NEW.deleted_at IS NULL THEN 'WATERMARK_CALIBRATION_UPSERTED' ELSE 'WATERMARK_CALIBRATION_DELETED' END,
    json_object(
      'contract_version', 1,
      'device_eui', upper(NEW.deveui),
      'gateway_device_eui', upper(COALESCE(
        NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
        NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
      )),
      'pullup_1_ohm', NEW.pullup_1_ohm, 'pulldown_1_ohm', NEW.pulldown_1_ohm,
      'series_fwd_1_ohm', NEW.series_fwd_1_ohm, 'series_rev_1_ohm', NEW.series_rev_1_ohm,
      'pullup_2_ohm', NEW.pullup_2_ohm, 'pulldown_2_ohm', NEW.pulldown_2_ohm,
      'series_fwd_2_ohm', NEW.series_fwd_2_ohm, 'series_rev_2_ohm', NEW.series_rev_2_ohm,
      'measured_at', NEW.measured_at, 'method', NEW.method,
      'worst_residual_pct', NEW.worst_residual_pct, 'notes', NEW.notes,
      'sync_version', NEW.sync_version, 'updated_at', NEW.updated_at, 'deleted_at', NEW.deleted_at
    ), NEW.sync_version, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), upper(COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
    ))
  );
END;

CREATE TRIGGER trg_watermark_calibrations_outbox_au
AFTER UPDATE ON watermark_calibrations FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND COALESCE(
    NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
    NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
  ) <> ''
  AND (
    NEW.pullup_1_ohm IS NOT OLD.pullup_1_ohm OR NEW.pulldown_1_ohm IS NOT OLD.pulldown_1_ohm OR
    NEW.series_fwd_1_ohm IS NOT OLD.series_fwd_1_ohm OR NEW.series_rev_1_ohm IS NOT OLD.series_rev_1_ohm OR
    NEW.pullup_2_ohm IS NOT OLD.pullup_2_ohm OR NEW.pulldown_2_ohm IS NOT OLD.pulldown_2_ohm OR
    NEW.series_fwd_2_ohm IS NOT OLD.series_fwd_2_ohm OR NEW.series_rev_2_ohm IS NOT OLD.series_rev_2_ohm OR
    NEW.measured_at IS NOT OLD.measured_at OR NEW.method IS NOT OLD.method OR
    NEW.worst_residual_pct IS NOT OLD.worst_residual_pct OR NEW.notes IS NOT OLD.notes OR
    NEW.sync_version IS NOT OLD.sync_version OR NEW.updated_at IS NOT OLD.updated_at OR
    NEW.deleted_at IS NOT OLD.deleted_at
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))), 'WATERMARK_CALIBRATION', upper(NEW.deveui),
    CASE WHEN NEW.deleted_at IS NULL THEN 'WATERMARK_CALIBRATION_UPSERTED' ELSE 'WATERMARK_CALIBRATION_DELETED' END,
    json_object(
      'contract_version', 1,
      'device_eui', upper(NEW.deveui),
      'gateway_device_eui', upper(COALESCE(
        NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
        NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
      )),
      'pullup_1_ohm', NEW.pullup_1_ohm, 'pulldown_1_ohm', NEW.pulldown_1_ohm,
      'series_fwd_1_ohm', NEW.series_fwd_1_ohm, 'series_rev_1_ohm', NEW.series_rev_1_ohm,
      'pullup_2_ohm', NEW.pullup_2_ohm, 'pulldown_2_ohm', NEW.pulldown_2_ohm,
      'series_fwd_2_ohm', NEW.series_fwd_2_ohm, 'series_rev_2_ohm', NEW.series_rev_2_ohm,
      'measured_at', NEW.measured_at, 'method', NEW.method,
      'worst_residual_pct', NEW.worst_residual_pct, 'notes', NEW.notes,
      'sync_version', NEW.sync_version, 'updated_at', NEW.updated_at, 'deleted_at', NEW.deleted_at
    ), NEW.sync_version, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), upper(COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.deveui AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
    ))
  );
END;
