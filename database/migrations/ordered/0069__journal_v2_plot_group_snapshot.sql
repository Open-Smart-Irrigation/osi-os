-- risk: destructive
-- Extends closed V2 operation/kind checks while preserving queue and replay history.
DROP VIEW journal_v2_pending_proposal_overlay;
DROP TRIGGER trg_journal_attachment_edge_parent_bi;
DROP TRIGGER trg_journal_attachment_edge_parent_bu;

CREATE TABLE journal_edge_mutations_next (
  mutation_uuid TEXT PRIMARY KEY,
  workspace_uuid TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'ENTRY_CREATE','ENTRY_CORRECT','ENTRY_VOID','PRODUCT_UPSERT',
    'CUSTOM_VOCAB_UPSERT','PLOT_SNAPSHOT','PLOT_GROUP_SNAPSHOT','CUTOVER_BARRIER_RECEIPT'
  )),
  resource_uuid TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','applied','already-applied','conflict')),
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  result_revision_uuid TEXT, conflict_uuid TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT, last_error TEXT, recorded_at TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, completed_at TEXT
);
INSERT INTO journal_edge_mutations_next SELECT * FROM journal_edge_mutations;
DROP TABLE journal_edge_mutations;
ALTER TABLE journal_edge_mutations_next RENAME TO journal_edge_mutations;
CREATE INDEX idx_journal_edge_mutations_pending ON journal_edge_mutations(status,next_attempt_at,created_at,mutation_uuid);
CREATE INDEX idx_journal_edge_mutations_workspace_resource ON journal_edge_mutations(workspace_uuid,resource_uuid,status,created_at);

CREATE VIEW journal_v2_pending_proposal_overlay AS
SELECT workspace_uuid,
       resource_uuid AS entry_uuid,
       mutation_uuid,
       operation,
       payload_json,
       status,
       created_at
  FROM journal_edge_mutations
 WHERE operation IN ('ENTRY_CREATE','ENTRY_CORRECT','ENTRY_VOID')
   AND status IN ('pending','in_flight','conflict');

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

CREATE TABLE journal_replication_applied_next (
  workspace_uuid TEXT NOT NULL, sequence TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'ENTRY_HEAD','ENTRY_CONFLICT','REFERENCE_DATA','PLOT_SNAPSHOT','PLOT_GROUP_SNAPSHOT',
    'CROP_CYCLE_PROJECTION','ATTACHMENT_DESCRIPTOR','AUTHORITY_STATE'
  )),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(workspace_uuid,sequence)
);
INSERT INTO journal_replication_applied_next SELECT * FROM journal_replication_applied;
DROP TABLE journal_replication_applied;
ALTER TABLE journal_replication_applied_next RENAME TO journal_replication_applied;

CREATE TABLE journal_v2_plot_group_snapshots (
  workspace_uuid TEXT NOT NULL,
  group_uuid TEXT NOT NULL,
  snapshot_uuid TEXT NOT NULL,
  gateway_device_eui TEXT NOT NULL,
  projection_version INTEGER NOT NULL CHECK (projection_version >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_uuid,group_uuid)
);
