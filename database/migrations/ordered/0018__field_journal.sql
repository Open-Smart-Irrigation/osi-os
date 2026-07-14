-- risk: additive
-- 0018: Field journal core schema (spec docs/superpowers/specs/2026-07-12-field-journal-design.md §4)

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_uuid TEXT UNIQUE NOT NULL,
  owner_user_uuid TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  author_principal_uuid TEXT NOT NULL,
  author_label TEXT,
  plot_uuid TEXT,
  zone_id INTEGER,
  zone_uuid TEXT,
  device_eui TEXT,
  season_uuid TEXT,
  season_crop TEXT,
  season_variety TEXT,
  campaign_uuid TEXT,
  protocol_code TEXT,
  protocol_version TEXT,
  observation_unit_code TEXT,
  pass_uuid TEXT,
  batch_uuid TEXT,
  activity_code TEXT NOT NULL,
  template_code TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  layout_code TEXT NOT NULL,
  layout_version INTEGER NOT NULL,
  catalog_version INTEGER NOT NULL,
  occurred_start TEXT NOT NULL,
  occurred_end TEXT,
  occurred_timezone TEXT NOT NULL,
  occurred_utc_offset_minutes INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('edge-ui','cloud-ui')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','voided')),
  voided_at TEXT,
  voided_by_principal_uuid TEXT,
  void_reason TEXT,
  note TEXT,
  context_json TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_journal_entries_zone_time
  ON journal_entries(zone_id, occurred_start DESC, entry_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_gateway_time
  ON journal_entries(gateway_device_eui, occurred_start DESC, entry_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_duplicate
  ON journal_entries(zone_id, activity_code, occurred_start, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_sticky
  ON journal_entries(author_principal_uuid, zone_id, recorded_at DESC, entry_uuid)
  WHERE status = 'final' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS journal_entry_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_uuid TEXT NOT NULL REFERENCES journal_entries(entry_uuid) ON DELETE CASCADE,
  attribute_code TEXT NOT NULL,
  group_index INTEGER NOT NULL DEFAULT 0 CHECK (group_index >= 0),
  value_status TEXT NOT NULL DEFAULT 'observed'
    CHECK (value_status IN ('observed','not_observed','not_applicable','below_detection')),
  value_num REAL,
  value_text TEXT,
  unit_code TEXT,
  entered_value_num REAL,
  entered_unit_code TEXT,
  CHECK ( (value_status = 'observed' AND ((value_num IS NULL) <> (value_text IS NULL)))
       OR (value_status <> 'observed' AND value_num IS NULL AND value_text IS NULL) ),
  UNIQUE (entry_uuid, group_index, attribute_code)
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_values_entry ON journal_entry_values(entry_uuid);

CREATE TABLE IF NOT EXISTS journal_vocab (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('activity','attribute','unit','choice')),
  parent_code TEXT,
  value_type TEXT CHECK (value_type IN ('number','text','choice','date','boolean')),
  quantity_kind TEXT,
  basis TEXT,
  default_unit_code TEXT,
  labels_json TEXT NOT NULL DEFAULT '{}',
  icon_key TEXT,
  constraints_json TEXT,
  agrovoc_uri TEXT, icasa_code TEXT, adapt_code TEXT,   -- non-authoritative caches
  scope TEXT NOT NULL DEFAULT 'core' CHECK (scope IN ('core','custom')),
  owner_user_uuid TEXT,
  gateway_device_eui TEXT,
  custom_field_uuid TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS journal_vocab_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_code TEXT NOT NULL REFERENCES journal_vocab(code),
  scheme_uri TEXT NOT NULL,
  scheme_version TEXT NOT NULL,
  mapping_role TEXT NOT NULL CHECK (mapping_role IN
    ('concept','variable','coded_value','operation_type','data_type_definition','unit_of_measure')),
  external_id TEXT NOT NULL,
  external_parent_id TEXT,
  mapping_relation TEXT NOT NULL DEFAULT 'exact'
    CHECK (mapping_relation IN ('exact','close','broad','narrow','related')),
  source_uri TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (term_code, scheme_uri, mapping_role, external_id)
);

CREATE TABLE IF NOT EXISTS journal_templates (
  code TEXT NOT NULL,
  version INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  definition_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (code, version)
);

CREATE TABLE IF NOT EXISTS journal_layouts (
  code TEXT NOT NULL,
  version INTEGER NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  definition_json TEXT NOT NULL,          -- includes option_dependencies + supported_templates
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (code, version)
);

CREATE TABLE IF NOT EXISTS journal_plots (
  plot_uuid TEXT PRIMARY KEY,
  plot_code TEXT NOT NULL,
  name TEXT,
  zone_uuid TEXT,
  station_code TEXT,
  crop_hint TEXT,
  area_m2 REAL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sync_version INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  UNIQUE (gateway_device_eui, plot_code)
);

CREATE TABLE IF NOT EXISTS journal_plot_groups (
  group_uuid TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  gateway_device_eui TEXT,
  created_by_principal_uuid TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  resolved_by_principal_uuid TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS journal_plot_group_members (
  group_uuid TEXT NOT NULL REFERENCES journal_plot_groups(group_uuid) ON DELETE CASCADE,
  plot_uuid TEXT NOT NULL REFERENCES journal_plots(plot_uuid) ON DELETE CASCADE,
  PRIMARY KEY (group_uuid, plot_uuid)
);

CREATE TABLE IF NOT EXISTS journal_plot_settings (
  plot_uuid TEXT PRIMARY KEY,
  layout_code TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_principal_uuid TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journal_products (
  product_uuid TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'core' CHECK (scope IN ('core','farm')),
  owner_user_uuid TEXT,
  gateway_device_eui TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mineral','organic_amendment','plant_protection','other')),
  composition_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS journal_attachments (
  attachment_uuid TEXT PRIMARY KEY,
  entry_uuid TEXT NOT NULL REFERENCES journal_entries(entry_uuid) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('photo')),
  original_filename TEXT,
  mime TEXT,
  size_bytes INTEGER CHECK (size_bytes >= 0),
  sha256 TEXT CHECK (length(sha256) = 64),
  blob_uuid TEXT,
  local_relpath TEXT,
  remote_object_key TEXT,
  transfer_state TEXT NOT NULL DEFAULT 'local_only'
    CHECK (transfer_state IN ('local_only','uploading','uploaded','failed')),
  captured_at TEXT,
  sync_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_attachments_entry ON journal_attachments(entry_uuid, deleted_at);

CREATE TABLE IF NOT EXISTS journal_catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  catalog_version INTEGER NOT NULL,
  catalog_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
