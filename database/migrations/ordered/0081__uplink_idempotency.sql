-- risk: additive
-- The canonical row is the durable receipt for an MQTT uplink. NULL keeps
-- legacy/unkeyable observations writable; existing history is unchanged.
ALTER TABLE device_data ADD COLUMN uplink_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_data_uplink
  ON device_data(deveui, uplink_key) WHERE uplink_key IS NOT NULL;
ALTER TABLE watermark_readings ADD COLUMN uplink_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_watermark_readings_uplink
  ON watermark_readings(deveui, uplink_key) WHERE uplink_key IS NOT NULL;
ALTER TABLE sdi12_transmissions ADD COLUMN uplink_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sdi12_transmissions_uplink
  ON sdi12_transmissions(deveui, uplink_key) WHERE uplink_key IS NOT NULL;
