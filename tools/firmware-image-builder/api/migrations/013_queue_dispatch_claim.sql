CREATE TABLE queue_dispatch_claims (
  claim_id INTEGER PRIMARY KEY CHECK (claim_id = 1),
  job_id TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('pre-start', 'start-attempted')),
  start_attempted_at TEXT,
  unit_inactive_at TEXT,
  CHECK (
    (phase = 'pre-start' AND start_attempted_at IS NULL AND unit_inactive_at IS NULL)
    OR (phase = 'start-attempted' AND start_attempted_at IS NOT NULL AND unit_inactive_at IS NOT NULL)
  ),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX queue_dispatch_claims_expiry ON queue_dispatch_claims (lease_expires_at);
