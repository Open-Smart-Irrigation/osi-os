-- 2026-05-16: WS1 STREGA actuation expectations and zone irrigation calibration.
-- Idempotent: safe to re-run; uses IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS valve_actuation_expectations (
    expectation_id              TEXT PRIMARY KEY,
    device_eui                  TEXT NOT NULL,
    zone_id                     INTEGER,
    command_id                  TEXT,
    effect_key                  TEXT,
    commanded_at                TEXT NOT NULL,
    commanded_duration_seconds  INTEGER NOT NULL,
    expected_close_at           TEXT NOT NULL,
    flow_rate_lpm               REAL,
    flow_rate_source            TEXT,
    estimated_gross_liters      REAL,
    volume_source               TEXT NOT NULL,
    observed_open_at            TEXT,
    observed_close_at           TEXT,
    reconciliation_state        TEXT NOT NULL DEFAULT 'PENDING_OBSERVATION',
    cancel_reason               TEXT,
    created_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_valve_act_exp_device_eui
    ON valve_actuation_expectations(device_eui);

CREATE INDEX IF NOT EXISTS idx_valve_act_exp_active
    ON valve_actuation_expectations(reconciliation_state)
    WHERE reconciliation_state IN ('PENDING_OBSERVATION', 'OBSERVED_RUNNING');

CREATE INDEX IF NOT EXISTS idx_valve_act_exp_effect_key
    ON valve_actuation_expectations(effect_key);

CREATE TABLE IF NOT EXISTS zone_irrigation_calibration (
    zone_id                  INTEGER PRIMARY KEY,
    valve_device_eui         TEXT,
    measured_flow_rate_lpm   REAL NOT NULL,
    measurement_method       TEXT NOT NULL,
    measured_at              TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
);
