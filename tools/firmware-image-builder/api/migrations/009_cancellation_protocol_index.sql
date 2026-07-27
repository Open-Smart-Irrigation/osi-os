CREATE INDEX job_events_cancellation_protocol
ON job_events (
  job_id,
  seq,
  json_extract(payload_json, '$.kind')
)
WHERE event_type = 'cleanup'
  AND json_extract(payload_json, '$.kind')
    IN ('cancellation-evidence', 'cancellation-cleanup');
