ALTER TABLE jobs ADD COLUMN cancellation_clock_high_water_at TEXT;
ALTER TABLE jobs ADD COLUMN cancellation_stop_authorized_at TEXT;
ALTER TABLE jobs ADD COLUMN cancellation_stop_authorized_lease_expires_at TEXT
  CHECK (
    (cancellation_stop_authorized_at IS NULL
      AND cancellation_stop_authorized_lease_expires_at IS NULL)
    OR
    (cancellation_stop_authorized_at IS NOT NULL
      AND cancellation_stop_authorized_lease_expires_at IS NOT NULL
      AND cancellation_stop_intent_at IS NOT NULL
      AND cancellation_escalation_owner IS NOT NULL
      AND cancellation_stop_authorized_at >= cancellation_stop_intent_at
      AND cancellation_stop_authorized_lease_expires_at > cancellation_stop_authorized_at)
  );

UPDATE jobs
SET cancellation_clock_high_water_at =
  CASE
    WHEN cancellation_stop_intent_at IS NOT NULL
      AND cancellation_stop_intent_at > cancel_requested_at
      THEN cancellation_stop_intent_at
    ELSE cancel_requested_at
  END
WHERE cancel_requested_at IS NOT NULL
  AND state IN (
    'starting', 'preflight', 'source', 'release_gates', 'frontend',
    'target_setup', 'feeds', 'config', 'building', 'verifying',
    'cancel_requested'
  );
