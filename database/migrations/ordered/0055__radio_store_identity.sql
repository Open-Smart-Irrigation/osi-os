-- risk: additive
-- Durable marker binding the dedicated radio store to this edge installation.
CREATE TABLE radio_store_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  radio_store_uuid TEXT NOT NULL UNIQUE,
  installation_uuid TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('CREATING', 'ACTIVE', 'RESTORING', 'RECONCILING', 'BLOCKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE radio_history_bridge (
  history_key TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'transferred', 'blocked')),
  claimed_at TEXT,
  transferred_at TEXT,
  last_error TEXT
);

CREATE INDEX idx_radio_history_bridge_status
  ON radio_history_bridge(status, claimed_at, history_key);
