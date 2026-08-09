-- risk: additive
-- Durable edge queue, cloud projection, and cursor state for Journal V2.

CREATE TABLE journal_authority_state (
  workspace_uuid TEXT PRIMARY KEY,
  gateway_device_eui TEXT,
  authority_state TEXT NOT NULL DEFAULT 'legacy'
    CHECK (authority_state IN ('legacy','cloud_primary')),
  state TEXT
    CHECK (state IS NULL OR state IN (
      'PREPARE_REQUESTED','COMMANDS_FENCED','BARRIER_RECORDED','LEGACY_DRAINED',
      'RECONCILED','ACTIVATED','BLOCKED','ABORTED'
    )),
  transition_uuid TEXT,
  barrier_uuid TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE journal_edge_mutations (
  mutation_uuid TEXT PRIMARY KEY,
  workspace_uuid TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'ENTRY_CREATE','ENTRY_CORRECT','ENTRY_VOID','PRODUCT_UPSERT',
    'CUSTOM_VOCAB_UPSERT','PLOT_SNAPSHOT','CUTOVER_BARRIER_RECEIPT'
  )),
  resource_uuid TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','in_flight','applied','already-applied','conflict'
  )),
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  result_revision_uuid TEXT,
  conflict_uuid TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_journal_edge_mutations_pending
  ON journal_edge_mutations(status,next_attempt_at,created_at,mutation_uuid);
CREATE INDEX idx_journal_edge_mutations_workspace_resource
  ON journal_edge_mutations(workspace_uuid,resource_uuid,status,created_at);

CREATE TABLE journal_replication_cursor (
  workspace_uuid TEXT PRIMARY KEY,
  sequence TEXT NOT NULL DEFAULT '0'
    CHECK (sequence='0' OR (sequence NOT GLOB '*[^0-9]*' AND substr(sequence,1,1) <> '0')),
  payload_sha256 TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE journal_replication_applied (
  workspace_uuid TEXT NOT NULL,
  sequence TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'ENTRY_HEAD','ENTRY_CONFLICT','REFERENCE_DATA','PLOT_SNAPSHOT',
    'CROP_CYCLE_PROJECTION','ATTACHMENT_DESCRIPTOR','AUTHORITY_STATE'
  )),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY(workspace_uuid,sequence)
);

CREATE TABLE journal_gateway_v2_capability (
  gateway_device_eui TEXT PRIMARY KEY,
  contract_version INTEGER NOT NULL DEFAULT 2 CHECK (contract_version=2),
  offered_fingerprint TEXT,
  accepted_fingerprint TEXT,
  capability_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (capability_state IN ('unknown','offered','accepted','rejected')),
  updated_at TEXT NOT NULL
);

CREATE TABLE journal_migration_ledger (
  workspace_uuid TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_uuid TEXT NOT NULL,
  source_sync_version INTEGER NOT NULL CHECK (source_sync_version >= 0),
  source_payload_sha256 TEXT NOT NULL CHECK (
    length(source_payload_sha256)=64 AND source_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  mutation_uuid TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending','queued','applied','already-applied','conflict','blocked'
  )),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_uuid,resource_type,resource_uuid)
);

CREATE TABLE journal_v2_entry_heads (
  workspace_uuid TEXT NOT NULL,
  entry_uuid TEXT NOT NULL,
  revision_uuid TEXT NOT NULL,
  sync_version INTEGER NOT NULL CHECK (sync_version >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_uuid,entry_uuid)
);

CREATE TABLE journal_v2_entry_values (
  workspace_uuid TEXT NOT NULL,
  entry_uuid TEXT NOT NULL,
  attribute_code TEXT NOT NULL,
  group_index INTEGER NOT NULL CHECK (group_index >= 0),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  PRIMARY KEY(workspace_uuid,entry_uuid,group_index,attribute_code),
  FOREIGN KEY(workspace_uuid,entry_uuid)
    REFERENCES journal_v2_entry_heads(workspace_uuid,entry_uuid) ON DELETE CASCADE
);

CREATE TABLE journal_v2_entry_conflicts (
  workspace_uuid TEXT NOT NULL,
  conflict_uuid TEXT NOT NULL,
  entry_uuid TEXT NOT NULL,
  current_revision_uuid TEXT NOT NULL,
  candidate_revision_uuid TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  disposition TEXT NOT NULL,
  reason TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_uuid,conflict_uuid)
);
CREATE INDEX idx_journal_v2_conflicts_entry
  ON journal_v2_entry_conflicts(workspace_uuid,entry_uuid,disposition);

CREATE TABLE journal_v2_reference_data (
  workspace_uuid TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('product','custom_vocab')),
  resource_uuid TEXT NOT NULL,
  sync_version INTEGER NOT NULL CHECK (sync_version >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_uuid,resource_type,resource_uuid)
);

CREATE TABLE journal_v2_plot_snapshots (
  workspace_uuid TEXT NOT NULL,
  plot_uuid TEXT NOT NULL,
  snapshot_uuid TEXT NOT NULL,
  gateway_device_eui TEXT NOT NULL,
  projection_version INTEGER NOT NULL CHECK (projection_version >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_uuid,plot_uuid)
);

CREATE TABLE journal_v2_crop_cycles (
  workspace_uuid TEXT NOT NULL,
  cycle_uuid TEXT NOT NULL,
  sync_version INTEGER NOT NULL CHECK (sync_version >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(workspace_uuid,cycle_uuid)
);

CREATE TABLE journal_v2_crop_cycle_plots (
  workspace_uuid TEXT NOT NULL,
  cycle_uuid TEXT NOT NULL,
  plot_uuid TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY(workspace_uuid,cycle_uuid,plot_uuid),
  FOREIGN KEY(workspace_uuid,cycle_uuid)
    REFERENCES journal_v2_crop_cycles(workspace_uuid,cycle_uuid) ON DELETE CASCADE
);

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
