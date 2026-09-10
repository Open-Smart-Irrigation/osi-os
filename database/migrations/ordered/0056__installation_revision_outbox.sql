-- risk: additive
-- Queue immutable installation assertions, including writes made while unlinked.

CREATE TRIGGER trg_device_installation_location_revisions_outbox_ai
AFTER INSERT ON device_installation_location_revisions
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui)
  VALUES(lower(hex(randomblob(16))),'DEVICE_INSTALLATION_LOCATION',NEW.revision_uuid,'DEVICE_INSTALLATION_LOCATION_REVISED',
    json_object(
      'contract_version', 1,
      'revision_uuid', NEW.revision_uuid,
      'device_eui', NEW.device_eui,
      'installation_uuid', NEW.installation_uuid,
      'source_gateway_device_eui', NEW.source_gateway_device_eui,
      'base_revision_uuid', NEW.base_revision_uuid,
      'revision_no', NEW.revision_no,
      'effective_from', NEW.effective_from,
      'recorded_at', NEW.recorded_at,
      'actor_user_uuid', NEW.actor_user_uuid,
      'supersedes_revision_uuid', NEW.supersedes_revision_uuid,
      'sync_version', NEW.sync_version,
      'created_at', NEW.created_at,
      'latitude', NEW.latitude,
      'longitude', NEW.longitude,
      'altitude_m', NEW.altitude_m,
      'vertical_reference', NEW.vertical_reference,
      'accuracy_m', NEW.accuracy_m,
      'antenna_height_agl_m', NEW.antenna_height_agl_m,
      'coordinate_source', NEW.coordinate_source
    ),NEW.sync_version,NEW.created_at,NEW.source_gateway_device_eui);
END;

CREATE TRIGGER trg_device_radio_configuration_revisions_outbox_ai
AFTER INSERT ON device_radio_configuration_revisions
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui)
  VALUES(lower(hex(randomblob(16))),'DEVICE_RADIO_CONFIGURATION',NEW.revision_uuid,'DEVICE_RADIO_CONFIGURATION_REVISED',
    json_object(
      'contract_version', 1,
      'revision_uuid', NEW.revision_uuid,
      'device_eui', NEW.device_eui,
      'installation_uuid', NEW.installation_uuid,
      'source_gateway_device_eui', NEW.source_gateway_device_eui,
      'base_revision_uuid', NEW.base_revision_uuid,
      'revision_no', NEW.revision_no,
      'effective_from', NEW.effective_from,
      'recorded_at', NEW.recorded_at,
      'actor_user_uuid', NEW.actor_user_uuid,
      'supersedes_revision_uuid', NEW.supersedes_revision_uuid,
      'sync_version', NEW.sync_version,
      'created_at', NEW.created_at,
      'tx_power_dbm', NEW.tx_power_dbm,
      'antenna_gain_dbi', NEW.antenna_gain_dbi,
      'feeder_loss_db', NEW.feeder_loss_db,
      'configuration_source', NEW.configuration_source
    ),NEW.sync_version,NEW.created_at,NEW.source_gateway_device_eui);
END;
