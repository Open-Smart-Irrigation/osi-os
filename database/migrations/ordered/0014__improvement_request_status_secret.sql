-- risk: additive
-- 0014: Add status secret hash to field-originated improvement requests.

ALTER TABLE improvement_requests ADD COLUMN status_secret_hash TEXT;

DROP TRIGGER IF EXISTS trg_improvement_requests_outbox_ai;

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
      'contact_email', NEW.contact_email,
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
      'status_secret_hash', NEW.status_secret_hash,
      'gui_user', json_object('local_user_id', NEW.user_id),
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.submitted_at
    ),
    NEW.sync_version,
    NEW.submitted_at,
    NEW.gateway_device_eui
  );
END;
