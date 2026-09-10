-- risk: additive
-- 0024: valve_schedules -> sync_outbox triggers (Valve control Phase B, edge half).
-- Trigger-only: schedule_uuid, sync_version, deleted_at already exist on
-- valve_schedules from Phase A (0022). Mirrors the trg_sync_schedules_outbox_*
-- pair (irrigation_schedules, see 0001/0003) but resolves gateway_device_eui
-- through devices (valve_schedules parents on a device, not a zone).
--
-- Aggregate: type 'VALVE_SCHEDULE', key = schedule_uuid, op 'VALVE_SCHEDULE_UPSERTED'.
-- deleted_at is carried in the upsert (D5) -- there is no separate
-- VALVE_SCHEDULE_DELETED op.
--
-- The _au guard deliberately omits once_fired_at: it is edge bookkeeping, and
-- store.updateSchedule() always bumps sync_version on every write (including a
-- ONCE firing), which is already in the guard -- so a production firing still
-- emits an event via the sync_version arm. Listing once_fired_at separately
-- would not change that; it would only be redundant with sync_version.

DROP TRIGGER IF EXISTS trg_sync_valve_schedules_outbox_ai;
CREATE TRIGGER trg_sync_valve_schedules_outbox_ai
AFTER INSERT ON valve_schedules
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'VALVE_SCHEDULE',
    NEW.schedule_uuid,
    'VALVE_SCHEDULE_UPSERTED',
    json_object(
      'contract_version', 1,
      'schedule_uuid',    NEW.schedule_uuid,
      'device_eui',       NEW.device_eui,
      'kind',             NEW.kind,
      'label',            NEW.label,
      'weekdays_mask',    NEW.weekdays_mask,
      'start_time',       NEW.start_time,
      'fire_at',          NEW.fire_at,
      'duration_minutes', NEW.duration_minutes,
      'timezone',         NEW.timezone,
      'enabled',          NEW.enabled,
      'once_state',       NEW.once_state,
      'deleted_at',       NEW.deleted_at,
      'sync_version',     NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.device_eui AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
    )
  );
END;

DROP TRIGGER IF EXISTS trg_sync_valve_schedules_outbox_au;
CREATE TRIGGER trg_sync_valve_schedules_outbox_au
AFTER UPDATE ON valve_schedules
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND (
    COALESCE(NEW.kind,'')             <> COALESCE(OLD.kind,'')             OR
    COALESCE(NEW.label,'')            <> COALESCE(OLD.label,'')            OR
    COALESCE(NEW.weekdays_mask,0)     <> COALESCE(OLD.weekdays_mask,0)     OR
    COALESCE(NEW.start_time,'')       <> COALESCE(OLD.start_time,'')       OR
    COALESCE(NEW.fire_at,'')          <> COALESCE(OLD.fire_at,'')          OR
    COALESCE(NEW.duration_minutes,0)  <> COALESCE(OLD.duration_minutes,0)  OR
    COALESCE(NEW.timezone,'')         <> COALESCE(OLD.timezone,'')         OR
    COALESCE(NEW.enabled,0)           <> COALESCE(OLD.enabled,0)           OR
    COALESCE(NEW.once_state,'')       <> COALESCE(OLD.once_state,'')       OR
    COALESCE(NEW.deleted_at,'')       <> COALESCE(OLD.deleted_at,'')       OR
    COALESCE(NEW.sync_version,0)      <> COALESCE(OLD.sync_version,0)
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'VALVE_SCHEDULE',
    NEW.schedule_uuid,
    'VALVE_SCHEDULE_UPSERTED',
    json_object(
      'contract_version', 1,
      'schedule_uuid',    NEW.schedule_uuid,
      'device_eui',       NEW.device_eui,
      'kind',             NEW.kind,
      'label',            NEW.label,
      'weekdays_mask',    NEW.weekdays_mask,
      'start_time',       NEW.start_time,
      'fire_at',          NEW.fire_at,
      'duration_minutes', NEW.duration_minutes,
      'timezone',         NEW.timezone,
      'enabled',          NEW.enabled,
      'once_state',       NEW.once_state,
      'deleted_at',       NEW.deleted_at,
      'sync_version',     NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.device_eui AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
    )
  );
END;
