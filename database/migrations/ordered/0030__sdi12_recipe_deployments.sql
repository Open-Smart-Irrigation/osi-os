-- risk: additive
-- Durable local state for SDI-12 recipe commissioning and address identification.

CREATE TABLE IF NOT EXISTS sdi12_recipe_deployments (
  deveui TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
  desired_version INTEGER NOT NULL DEFAULT 0,
  desired_layout_hash TEXT,
  desired_recipe_json TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'not_applied','queueing','queued','observed_once',
    'observed_compatible','degraded'
  )),
  queue_item_ids_json TEXT,
  queued_at TEXT,
  queue_drained_at TEXT,
  commissioning_deadline_at TEXT,
  observed_count INTEGER NOT NULL DEFAULT 0,
  failed_observation_count INTEGER NOT NULL DEFAULT 0,
  last_observed_at TEXT,
  last_error_code TEXT,
  compatible_recipe_json TEXT,
  compatible_layout_json TEXT,
  compatible_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sdi12_recipe_deployments_status
  ON sdi12_recipe_deployments(status);

CREATE TABLE IF NOT EXISTS sdi12_identify_attempts (
  deveui TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('discovering','identifying')),
  discovered_address TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
