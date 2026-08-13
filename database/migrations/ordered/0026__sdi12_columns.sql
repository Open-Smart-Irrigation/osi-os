-- risk: additive
-- 0026: DRAGINO_SDI12 telemetry + device-config columns.
-- 8-depth VWC / soil temperature / soil EC (spec 2026-08-13), plus the
-- per-device probe profile, identify status, and raw aI! identity string.

ALTER TABLE device_data ADD COLUMN vwc_1 REAL;
ALTER TABLE device_data ADD COLUMN vwc_2 REAL;
ALTER TABLE device_data ADD COLUMN vwc_3 REAL;
ALTER TABLE device_data ADD COLUMN vwc_4 REAL;
ALTER TABLE device_data ADD COLUMN vwc_5 REAL;
ALTER TABLE device_data ADD COLUMN vwc_6 REAL;
ALTER TABLE device_data ADD COLUMN vwc_7 REAL;
ALTER TABLE device_data ADD COLUMN vwc_8 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_1 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_2 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_3 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_4 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_5 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_6 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_7 REAL;
ALTER TABLE device_data ADD COLUMN soil_temp_8 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_1 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_2 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_3 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_4 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_5 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_6 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_7 REAL;
ALTER TABLE device_data ADD COLUMN soil_ec_8 REAL;
ALTER TABLE devices ADD COLUMN sdi12_probe_profile TEXT;
ALTER TABLE devices ADD COLUMN sdi12_probe_status TEXT
  CHECK(sdi12_probe_status IN ('pending_identify','identified','unmatched','manual'));
ALTER TABLE devices ADD COLUMN sdi12_identity TEXT;
