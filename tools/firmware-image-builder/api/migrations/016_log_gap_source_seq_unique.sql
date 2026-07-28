CREATE UNIQUE INDEX job_events_log_gap_source_seq
ON job_events (
  job_id,
  CAST(json_extract(payload_json, '$.sourceSeq') AS INTEGER)
)
WHERE event_type = 'log-gap'
  AND json_type(payload_json, '$.sourceSeq') = 'integer';
