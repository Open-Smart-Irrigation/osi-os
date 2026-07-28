CREATE UNIQUE INDEX job_events_log_gap_source_seq
ON job_events (
  job_id,
  json_extract(payload_json, '$.sourceSeq')
)
WHERE event_type = 'log-gap'
  AND json_type(payload_json, '$.sourceSeq') IN ('integer', 'real');
