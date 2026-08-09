-- risk: additive
-- Durable Journal V2 attachment descriptors and bounded edge media cache.

CREATE TABLE journal_attachment_replicas (
  attachment_uuid TEXT PRIMARY KEY,
  workspace_uuid TEXT NOT NULL,
  entry_uuid TEXT NOT NULL,
  entry_revision_uuid TEXT NOT NULL,
  parent_mutation_uuid TEXT,
  source TEXT NOT NULL DEFAULT 'cloud' CHECK (source IN ('cloud','edge')),
  content_role TEXT NOT NULL,
  parent_disposition TEXT NOT NULL CHECK (parent_disposition IN ('canonical','conflict')),
  original_filename TEXT,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  sync_version INTEGER NOT NULL CHECK (sync_version >= 0),
  descriptor_state TEXT NOT NULL,
  replica_status TEXT NOT NULL DEFAULT 'download_queued' CHECK (replica_status IN (
    'local_only','uploading','verified','download_queued','downloading',
    'failed_retryable','failed_terminal','missing_legacy','unreadable','evicted_verified'
  )),
  cloud_registration_state TEXT NOT NULL DEFAULT 'not_registered' CHECK (
    cloud_registration_state IN ('not_registered','registering','registered')
  ),
  verified_sha256 TEXT,
  verified_at TEXT,
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  received_ranges_json TEXT CHECK (received_ranges_json IS NULL OR json_valid(received_ranges_json)),
  next_retry_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  last_error TEXT,
  captured_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_journal_attachment_replicas_retry
  ON journal_attachment_replicas(replica_status,next_retry_at,attachment_uuid);
CREATE INDEX idx_journal_attachment_replicas_parent
  ON journal_attachment_replicas(workspace_uuid,entry_revision_uuid,parent_disposition);

CREATE TABLE journal_media_files (
  media_uuid TEXT PRIMARY KEY,
  attachment_uuid TEXT UNIQUE REFERENCES journal_attachment_replicas(attachment_uuid),
  workspace_uuid TEXT NOT NULL,
  parent_mutation_uuid TEXT,
  parent_revision_uuid TEXT,
  local_path TEXT NOT NULL UNIQUE,
  partial_path TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  received_ranges_json TEXT CHECK (received_ranges_json IS NULL OR json_valid(received_ranges_json)),
  replica_status TEXT NOT NULL CHECK (replica_status IN (
    'local_only','uploading','verified','download_queued','downloading',
    'failed_retryable','failed_terminal','missing_legacy','unreadable','evicted_verified'
  )),
  cloud_replica_status TEXT CHECK (cloud_replica_status IS NULL OR cloud_replica_status IN (
    'uploading','verified','failed_retryable','failed_terminal','missing_legacy','unreadable'
  )),
  cloud_verified_sha256 TEXT,
  cloud_verified_at TEXT,
  next_retry_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  conflict_bound INTEGER NOT NULL DEFAULT 0 CHECK (conflict_bound IN (0,1)),
  last_error TEXT,
  last_accessed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_mutation_uuid IS NOT NULL OR parent_revision_uuid IS NOT NULL),
  CHECK (received_bytes <= size_bytes)
);
CREATE INDEX idx_journal_media_files_eviction
  ON journal_media_files(pinned,conflict_bound,replica_status,last_accessed_at,media_uuid);
CREATE INDEX idx_journal_media_files_parent_mutation
  ON journal_media_files(parent_mutation_uuid,parent_revision_uuid);

CREATE TRIGGER trg_journal_attachment_source_immutable_bu
BEFORE UPDATE OF source ON journal_attachment_replicas
FOR EACH ROW
WHEN OLD.source <> NEW.source
BEGIN
  SELECT RAISE(ABORT,'journal attachment source is immutable');
END;

CREATE TRIGGER trg_journal_attachment_edge_binding_immutable_bu
BEFORE UPDATE OF workspace_uuid,entry_uuid,entry_revision_uuid,parent_mutation_uuid,
  parent_disposition,cloud_registration_state
ON journal_attachment_replicas
FOR EACH ROW
WHEN OLD.source='edge' AND OLD.cloud_registration_state <> 'not_registered' AND (
  OLD.workspace_uuid IS NOT NEW.workspace_uuid
  OR OLD.entry_uuid IS NOT NEW.entry_uuid
  OR OLD.entry_revision_uuid IS NOT NEW.entry_revision_uuid
  OR OLD.parent_mutation_uuid IS NOT NEW.parent_mutation_uuid
  OR OLD.parent_disposition IS NOT NEW.parent_disposition
  OR NEW.cloud_registration_state='not_registered'
)
BEGIN
  SELECT RAISE(ABORT,'journal attachment binding is immutable');
END;

CREATE TRIGGER trg_journal_attachment_edge_parent_bi
BEFORE INSERT ON journal_attachment_replicas
FOR EACH ROW
WHEN NEW.source='edge' AND NEW.cloud_registration_state <> 'not_registered'
BEGIN
  SELECT CASE WHEN NEW.parent_mutation_uuid IS NULL OR NOT EXISTS (
    SELECT 1 FROM journal_edge_mutations AS m
     WHERE m.mutation_uuid=NEW.parent_mutation_uuid
       AND m.workspace_uuid=NEW.workspace_uuid
       AND m.resource_uuid=NEW.entry_uuid
       AND m.result_revision_uuid=NEW.entry_revision_uuid
       AND (
         (m.status IN ('applied','already-applied') AND NEW.parent_disposition='canonical')
         OR (m.status='conflict' AND NEW.parent_disposition='conflict')
       )
  ) THEN RAISE(ABORT,'journal attachment parent outcome is not bound') END;
END;

CREATE TRIGGER trg_journal_attachment_edge_parent_bu
BEFORE UPDATE OF cloud_registration_state,entry_revision_uuid,parent_mutation_uuid,
  workspace_uuid,entry_uuid,source,parent_disposition
ON journal_attachment_replicas
FOR EACH ROW
WHEN NEW.source='edge' AND NEW.cloud_registration_state <> 'not_registered'
BEGIN
  SELECT CASE WHEN NEW.parent_mutation_uuid IS NULL OR NOT EXISTS (
    SELECT 1 FROM journal_edge_mutations AS m
     WHERE m.mutation_uuid=NEW.parent_mutation_uuid
       AND m.workspace_uuid=NEW.workspace_uuid
       AND m.resource_uuid=NEW.entry_uuid
       AND m.result_revision_uuid=NEW.entry_revision_uuid
       AND (
         (m.status IN ('applied','already-applied') AND NEW.parent_disposition='canonical')
         OR (m.status='conflict' AND NEW.parent_disposition='conflict')
       )
  ) THEN RAISE(ABORT,'journal attachment parent outcome is not bound') END;
END;
