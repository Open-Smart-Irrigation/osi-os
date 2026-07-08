-- risk: additive
-- 0005: Store field-originated improvement requests and sync them to OSI Server.

CREATE TABLE IF NOT EXISTS improvement_requests (
  request_uuid              TEXT PRIMARY KEY,
  user_id                   INTEGER NOT NULL,
  type                      TEXT NOT NULL CHECK (type IN ('bug','improvement','feedback')),
  title                     TEXT NOT NULL,
  description               TEXT NOT NULL,
  expected                  TEXT,
  actual                    TEXT,
  steps                     TEXT,
  area                      TEXT NOT NULL,
  severity                  TEXT NOT NULL CHECK (severity IN ('cant_work','workaround','annoying','idea')),
  consent_diagnostics       INTEGER NOT NULL DEFAULT 1 CHECK (consent_diagnostics IN (0,1)),
  consent_public            INTEGER NOT NULL CHECK (consent_public = 1),
  diagnostics_json          TEXT NOT NULL DEFAULT '{}',
  gateway_device_eui        TEXT,
  local_status              TEXT NOT NULL DEFAULT 'QUEUED',
  cloud_status              TEXT,
  cloud_reason              TEXT,
  cloud_human_message       TEXT,
  released_version          TEXT,
  submitted_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_status_at            TEXT,
  created_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_version              INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_improvement_requests_user_created_at
  ON improvement_requests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_improvement_requests_status
  ON improvement_requests(local_status, cloud_status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_improvement_requests_outbox_ai
AFTER INSERT ON improvement_requests
BEGIN
  INSERT OR IGNORE INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  )
  VALUES (
    'work-request-' || NEW.request_uuid,
    'WORK_REQUEST',
    NEW.request_uuid,
    'WORK_REQUEST_SUBMITTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'request_id', NEW.request_uuid,
      'type', NEW.type,
      'title', NEW.title,
      'description', NEW.description,
      'expected', NEW.expected,
      'actual', NEW.actual,
      'steps', NEW.steps,
      'area', NEW.area,
      'severity', NEW.severity,
      'consent_public', CASE WHEN NEW.consent_public = 1 THEN json('true') ELSE json('false') END,
      'consent_diagnostics', CASE WHEN NEW.consent_diagnostics = 1 THEN json('true') ELSE json('false') END,
      'diagnostics', json(NEW.diagnostics_json),
      'gateway_device_eui', NEW.gateway_device_eui,
      'gui_user', json_object('local_user_id', NEW.user_id),
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.submitted_at
    ),
    NEW.sync_version,
    NEW.submitted_at,
    NEW.gateway_device_eui
  );
END;
