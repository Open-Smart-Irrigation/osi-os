-- risk: additive
-- Ten-channel Sentek layout and telemetry. The two outbox decorators extend
-- boot-owned events without replacing their boot-recreated trigger bodies.

ALTER TABLE devices ADD COLUMN sdi12_channel_layout_json TEXT;

ALTER TABLE device_data ADD COLUMN vwc_9 REAL;
ALTER TABLE device_data ADD COLUMN vwc_10 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_1 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_2 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_3 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_4 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_5 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_6 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_7 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_8 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_9 REAL;
ALTER TABLE device_data ADD COLUMN soil_vic_10 REAL;

CREATE TRIGGER trg_sentek_device_outbox_payload_ai
AFTER INSERT ON sync_outbox
FOR EACH ROW
WHEN NEW.aggregate_type = 'DEVICE'
BEGIN
  UPDATE sync_outbox
  SET payload_json = json_set(
    payload_json,
    '$.sdi12_channel_layout_json',
    json((SELECT sdi12_channel_layout_json FROM devices WHERE deveui = NEW.aggregate_key))
  )
  WHERE event_uuid = NEW.event_uuid;
END;

CREATE TRIGGER trg_sentek_data_outbox_payload_ai
AFTER INSERT ON sync_outbox
FOR EACH ROW
WHEN NEW.aggregate_type = 'DEVICE_DATA' AND NEW.op = 'DEVICE_DATA_APPENDED'
BEGIN
  UPDATE sync_outbox
  SET payload_json = json_patch(
    payload_json,
    COALESCE((
      SELECT json_object(
        'vwc_9', dd.vwc_9,
        'vwc_10', dd.vwc_10,
        'soil_vic_1', dd.soil_vic_1,
        'soil_vic_2', dd.soil_vic_2,
        'soil_vic_3', dd.soil_vic_3,
        'soil_vic_4', dd.soil_vic_4,
        'soil_vic_5', dd.soil_vic_5,
        'soil_vic_6', dd.soil_vic_6,
        'soil_vic_7', dd.soil_vic_7,
        'soil_vic_8', dd.soil_vic_8,
        'soil_vic_9', dd.soil_vic_9,
        'soil_vic_10', dd.soil_vic_10
      )
      FROM device_data dd
      WHERE dd.deveui = json_extract(NEW.payload_json, '$.device_eui')
        AND dd.recorded_at = json_extract(NEW.payload_json, '$.recorded_at')
      ORDER BY dd.id DESC
      LIMIT 1
    ), '{}')
  )
  WHERE event_uuid = NEW.event_uuid;
END;
