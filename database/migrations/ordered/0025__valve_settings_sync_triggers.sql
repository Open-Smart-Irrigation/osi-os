-- risk: additive
-- 0025: valve_settings -> sync_outbox triggers + sync_version column (Bovey cloud
-- full-parity Task P2-E1, edge half). Mirrors trg_sync_valve_schedules_outbox_* (migration
-- 0024), but valve_settings' primary key IS device_eui (no separate UUID column), so
-- aggregate_key = device_eui directly.
--
-- Aggregate: type 'VALVE_SETTINGS', key = device_eui, op 'VALVE_SETTINGS_UPSERTED'.
--
-- sync_version does not exist on valve_settings yet (0022 predates the sync design).
-- Added here rather than as a separate prior step, since nothing else needs it until
-- this trigger pair does.
--
-- store.upsertSettings() (osi-valve-control/store.js) is the single write path for this
-- table: used by the REST PUT /settings + POST /scheduler-status routes, the
-- SET_VALVE_SCHEDULER_STATUS and UPSERT_VALVE_SETTINGS cloud command appliers -- AND by
-- workers.js/push.js on nearly every scheduler tick, to persist clock-sync push
-- bookkeeping (last_clock_sync_queued_at/acked_at) for a GEN2 valve. flow_rate_updated_at
-- is a companion timestamp for flow_rate_lpm/flow_rate_source, not itself a resource
-- field. Unlike 0024's store.updateSchedule() (which bumps sync_version unconditionally
-- because every one of its callers already only ever touches synced fields),
-- store.upsertSettings() only bumps sync_version when a write actually touches one of
-- the six synced columns (strega_generation, flow_rate_lpm, flow_rate_source,
-- default_open_minutes, scheduler_status, skip_today_date) -- otherwise a routine
-- 10-minute clock-sync tick across every GEN2 valve would flood sync_outbox with events
-- the cloud contract does not even model. The _au guard below compares those six synced
-- fields individually (not only sync_version) as belt-and-suspenders, matching 0024's
-- own style, even though in practice the sync_version arm alone already tracks them.
--
-- updated_at is stored as datetime('now') (space-separated, no fractional seconds or
-- 'Z') -- the same format valve_schedules.updated_at uses, which 0024's trigger payload
-- sidesteps by simply never syncing updated_at. This task's contract requires
-- updated_at on ValveSettings, so the payload reformats it via
-- strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at) to match CanonicalUtcTimestamp, rather
-- than changing the column's own storage format (which other queries/tests depend on).

ALTER TABLE valve_settings ADD COLUMN sync_version INTEGER DEFAULT 0;

DROP TRIGGER IF EXISTS trg_sync_valve_settings_outbox_ai;
CREATE TRIGGER trg_sync_valve_settings_outbox_ai
AFTER INSERT ON valve_settings
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'VALVE_SETTINGS',
    NEW.device_eui,
    'VALVE_SETTINGS_UPSERTED',
    json_object(
      'contract_version',     1,
      'device_eui',           NEW.device_eui,
      'strega_generation',    NEW.strega_generation,
      'flow_rate_lpm',        NEW.flow_rate_lpm,
      'flow_rate_source',     NEW.flow_rate_source,
      'default_open_minutes', NEW.default_open_minutes,
      'scheduler_status',     NEW.scheduler_status,
      'skip_today_date',      NEW.skip_today_date,
      'sync_version',         NEW.sync_version,
      'updated_at',           strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at)
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.device_eui AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
    )
  );
END;

DROP TRIGGER IF EXISTS trg_sync_valve_settings_outbox_au;
CREATE TRIGGER trg_sync_valve_settings_outbox_au
AFTER UPDATE ON valve_settings
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND (
    COALESCE(NEW.strega_generation,'')    <> COALESCE(OLD.strega_generation,'')    OR
    COALESCE(NEW.flow_rate_lpm,0)         <> COALESCE(OLD.flow_rate_lpm,0)         OR
    COALESCE(NEW.flow_rate_source,'')     <> COALESCE(OLD.flow_rate_source,'')     OR
    COALESCE(NEW.default_open_minutes,0)  <> COALESCE(OLD.default_open_minutes,0)  OR
    COALESCE(NEW.scheduler_status,'')     <> COALESCE(OLD.scheduler_status,'')     OR
    COALESCE(NEW.skip_today_date,'')      <> COALESCE(OLD.skip_today_date,'')      OR
    COALESCE(NEW.sync_version,0)          <> COALESCE(OLD.sync_version,0)
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'VALVE_SETTINGS',
    NEW.device_eui,
    'VALVE_SETTINGS_UPSERTED',
    json_object(
      'contract_version',     1,
      'device_eui',           NEW.device_eui,
      'strega_generation',    NEW.strega_generation,
      'flow_rate_lpm',        NEW.flow_rate_lpm,
      'flow_rate_source',     NEW.flow_rate_source,
      'default_open_minutes', NEW.default_open_minutes,
      'scheduler_status',     NEW.scheduler_status,
      'skip_today_date',      NEW.skip_today_date,
      'sync_version',         NEW.sync_version,
      'updated_at',           strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at)
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.device_eui AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
    )
  );
END;
