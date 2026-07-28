CREATE TABLE retention_prunes (
  prune_id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('row', 'evidence', 'log', 'worktree', 'cache', 'quarantine')),
  relative_path TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('removed', 'skipped', 'failed')),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', at) = at)
);

CREATE INDEX retention_prunes_at ON retention_prunes (at, prune_id);

CREATE TABLE retention_purge_authorizations (
  job_id TEXT PRIMARY KEY,
  authorized_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', authorized_at) = authorized_at),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

DROP TRIGGER job_operations_committed_delete_guard;
CREATE TRIGGER job_operations_committed_delete_guard
BEFORE DELETE ON job_operations
WHEN (OLD.outcome IS NOT NULL OR OLD.evidence_sha256 IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM retention_purge_authorizations WHERE job_id = OLD.job_id)
BEGIN
  SELECT RAISE(ABORT, 'committed operation evidence is immutable');
END;

DROP TRIGGER legacy_blocked_publish_evidence_delete_guard;
CREATE TRIGGER legacy_blocked_publish_evidence_delete_guard
BEFORE DELETE ON legacy_blocked_publish_evidence
WHEN NOT EXISTS (SELECT 1 FROM retention_purge_authorizations WHERE job_id = OLD.job_id)
BEGIN
  SELECT RAISE(ABORT, 'legacy blocked publish evidence is immutable');
END;

DROP TRIGGER cleanup_stop_authorization_outcomes_delete_guard;
CREATE TRIGGER cleanup_stop_authorization_outcomes_delete_guard
BEFORE DELETE ON cleanup_stop_authorization_outcomes
WHEN NOT EXISTS (SELECT 1 FROM retention_purge_authorizations WHERE job_id = OLD.job_id)
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization outcomes are immutable');
END;

DROP TRIGGER cleanup_stop_authorization_heads_delete_guard;
CREATE TRIGGER cleanup_stop_authorization_heads_delete_guard
BEFORE DELETE ON cleanup_stop_authorization_heads
WHEN NOT EXISTS (SELECT 1 FROM retention_purge_authorizations WHERE job_id = OLD.job_id)
BEGIN
  SELECT RAISE(ABORT, 'cleanup stop authorization heads are immutable');
END;
