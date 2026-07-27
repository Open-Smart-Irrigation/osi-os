ALTER TABLE jobs ADD COLUMN cancellation_cooperative_deadline_at TEXT;
ALTER TABLE jobs ADD COLUMN cancellation_escalation_owner TEXT;
ALTER TABLE jobs ADD COLUMN cancellation_escalation_lease_expires_at TEXT;
ALTER TABLE jobs ADD COLUMN cancellation_stop_intent_at TEXT;
ALTER TABLE jobs ADD COLUMN cancellation_grace_deadline_at TEXT;
ALTER TABLE jobs ADD COLUMN cancellation_signal_observation_json TEXT
  CHECK (cancellation_signal_observation_json IS NULL OR (
    json_valid(cancellation_signal_observation_json)
    AND json_type(cancellation_signal_observation_json) = 'object'
  ));
ALTER TABLE jobs ADD COLUMN cancellation_stop_observation_json TEXT
  CHECK (cancellation_stop_observation_json IS NULL OR (
    json_valid(cancellation_stop_observation_json)
    AND json_type(cancellation_stop_observation_json) = 'object'
  ));
ALTER TABLE jobs ADD COLUMN cancellation_inspection_observations_json TEXT
  CHECK (
    (cancellation_inspection_observations_json IS NULL OR (
      json_valid(cancellation_inspection_observations_json)
      AND json_type(cancellation_inspection_observations_json) = 'object'
    ))
    AND (
      (cancellation_escalation_owner IS NULL
        AND cancellation_escalation_lease_expires_at IS NULL
        AND cancellation_stop_intent_at IS NULL
        AND cancellation_grace_deadline_at IS NULL
        AND cancellation_stop_observation_json IS NULL
        AND cancellation_inspection_observations_json IS NULL)
      OR
      (cancellation_escalation_owner IS NOT NULL
        AND cancellation_escalation_lease_expires_at IS NOT NULL
        AND cancellation_stop_intent_at IS NOT NULL
        AND cancellation_grace_deadline_at IS NOT NULL)
    )
  );

UPDATE jobs
SET cancellation_cooperative_deadline_at =
  strftime('%Y-%m-%dT%H:%M:%fZ', cancel_requested_at, '+30 seconds')
WHERE cancel_requested_at IS NOT NULL
  AND state IN (
    'starting', 'preflight', 'source', 'release_gates', 'frontend',
    'target_setup', 'feeds', 'config', 'building', 'verifying',
    'cancel_requested'
  );
