-- risk: additive
CREATE TABLE radio_store_schema_ledger (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE radio_store_identity (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), radio_store_uuid TEXT NOT NULL UNIQUE, installation_uuid TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('CREATING','ACTIVE','RESTORING','RECONCILING','BLOCKED')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE radio_uplinks (id INTEGER PRIMARY KEY AUTOINCREMENT, installation_uuid TEXT NOT NULL, deveui TEXT NOT NULL, recorded_at TEXT NOT NULL, deduplication_id TEXT NOT NULL, metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)), dirty_generation INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX radio_uplinks_dedup ON radio_uplinks(installation_uuid, deduplication_id);
CREATE TABLE radio_history_dirty (history_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, change_kind TEXT NOT NULL DEFAULT 'correction', source_row_id INTEGER, changed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','transferred','blocked')));
