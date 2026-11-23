-- risk: additive
-- Report newly created schedules to the cloud at once (E5).
--
-- irrigation_schedules had an outbox trigger for UPDATE only. Every real
-- insert path supplies sync_version >= 1 and a non-null response_mode:
-- osi-daily-scheduler/schedule-save.js for the gateway GUI, and for cloud
-- commands osi-irrigation-policy/lifecycle.js plus the envelope-less
-- legacy "Build UPDATE SQL" UPSERT_SCHEDULE upsert in flows.json.
-- trg_sync_schedules_defaults_ai's normalizing UPDATE therefore changed
-- nothing and trg_sync_schedules_outbox_au's column-change guard never
-- fired: a newly created schedule reached the cloud at the next 6-hourly
-- bootstrap at the earliest, and a cloud "disable all schedules" could
-- miss it for up to 6 h.
-- The trigger below closes that gap with the same event shape, aggregate key
-- and payload as the update trigger.
--
-- The two extra WHEN guards partition inserts against the defaults trigger
-- so every insert emits exactly one event: an inserted row that still needs
-- normalization (sync_version 0/NULL or response_mode NULL) stays silent here
-- and is reported once by trg_sync_schedules_outbox_au when the defaults
-- UPDATE changes the row. Firing here as well would enqueue two
-- SCHEDULE_UPSERTED events at one version with different payloads, which the
-- cloud rejects as equal_version_payload_conflict.
--
-- A cloud-originated UPSERT_SCHEDULE insert emits the same confirmation echo
-- the update trigger already emits for cloud-command updates: one event at
-- the command's version carrying exactly the commanded values. Events never
-- spawn commands, so there is no loop.

CREATE TRIGGER trg_sync_schedules_outbox_ai
AFTER INSERT ON irrigation_schedules
FOR EACH ROW
WHEN
  EXISTS (
    SELECT 1 FROM sync_link_state
     WHERE peer_node = 'cloud' AND linked = 1
  )
  AND COALESCE(NEW.sync_version, 0) > 0
  AND NEW.response_mode IS NOT NULL
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'SCHEDULE',
    COALESCE((SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),''),
    'SCHEDULE_UPSERTED',
    json_object(
      'contract_version', 1,
      'zone_uuid',       (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL),
      'trigger_metric',  NEW.trigger_metric,
      'threshold_kpa',   NEW.threshold_kpa,
      'enabled',         NEW.enabled,
      'duration_minutes', NEW.duration_minutes,
      'response_mode',   NEW.response_mode,
      'sync_version',    NEW.sync_version,
      'deleted_at',      NEW.deleted_at,
      'last_applied_at', NEW.last_applied_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL)
  );
END;
