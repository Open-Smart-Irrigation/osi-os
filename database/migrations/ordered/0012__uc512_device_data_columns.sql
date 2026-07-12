-- risk: additive
-- 0012: UC512 telemetry columns in device_data (3.1).
-- Two-channel valve state + pulse counters + pipe pressure.

ALTER TABLE device_data ADD COLUMN valve_1_state TEXT;
ALTER TABLE device_data ADD COLUMN valve_2_state TEXT;
ALTER TABLE device_data ADD COLUMN valve_1_pulse INTEGER;
ALTER TABLE device_data ADD COLUMN valve_2_pulse INTEGER;
ALTER TABLE device_data ADD COLUMN pipe_pressure_kpa REAL;
