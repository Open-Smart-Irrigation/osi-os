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
SET cancellation_clock_high_water_at = MAX(
  cancel_requested_at,
  CASE
    WHEN cancellation_stop_intent_at IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', cancellation_stop_intent_at) = cancellation_stop_intent_at
      THEN cancellation_stop_intent_at
    ELSE cancel_requested_at
  END,
  CASE
    WHEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
      THEN updated_at
    ELSE cancel_requested_at
  END,
  COALESCE((
    SELECT MAX(event.at)
    FROM job_events AS event
    WHERE event.job_id = jobs.job_id
      AND strftime('%Y-%m-%dT%H:%M:%fZ', event.at) = event.at
      AND (
        event.event_type = 'cancellation_requested'
        OR (
          event.event_type = 'recovery'
          AND json_extract(event.payload_json, '$.kind') IN (
            'cancellation-coordination-initialized',
            'cancellation-signal-observed',
            'cancellation-stop-intent',
            'cancellation-stop-observed',
            'cancellation-inspection-observed',
            'cancellation-clock-observed',
            'cancellation-stop-authorized'
          )
        )
      )
  ), cancel_requested_at)
)
WHERE cancel_requested_at IS NOT NULL
  AND strftime('%Y-%m-%dT%H:%M:%fZ', cancel_requested_at) = cancel_requested_at
  AND state IN (
    'starting', 'preflight', 'source', 'release_gates', 'frontend',
    'target_setup', 'feeds', 'config', 'building', 'verifying',
    'cancel_requested'
  );
