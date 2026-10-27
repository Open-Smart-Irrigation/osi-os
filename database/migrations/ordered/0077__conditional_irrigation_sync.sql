-- risk: additive
-- 0077: conditional irrigation replication cache and guarded source triggers.
--
-- This migration replaces the legacy valve-schedule trigger definitions from
-- 0024 without changing that historical migration.  Conditional resources are
-- emitted only when the durable peer context still proves the exact current
-- server, account, gateway and installation support.  A legacy schedule (one
-- with neither conditional column set) retains the old linked-peer behavior.

CREATE TABLE IF NOT EXISTS conditional_irrigation_sync_projections (
  projection_kind     TEXT NOT NULL CHECK (projection_kind IN ('POLICY_RUNTIME','VALVE_RUNTIME','DECISION')),
  projection_key      TEXT NOT NULL,
  projection_revision INTEGER NOT NULL CHECK (projection_revision >= 1),
  payload_hash        TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload_json        TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (projection_kind, projection_key)
);

DROP TRIGGER IF EXISTS trg_sync_irrigation_policies_outbox_ai;
CREATE TRIGGER trg_sync_irrigation_policies_outbox_ai
AFTER INSERT ON irrigation_policies
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM sync_link_state s
  JOIN installation_identity i ON i.singleton_id = 1
  WHERE s.peer_node = 'cloud'
    AND s.linked = 1
    AND s.peer_capabilities_request_id IS NOT NULL
    AND trim(s.peer_capabilities_request_id) <> ''
    AND json_valid(s.peer_capabilities_json)
    AND json_type(s.peer_capabilities_json) = 'array'
    AND EXISTS (SELECT 1 FROM json_each(s.peer_capabilities_json) c WHERE c.value = 'conditional_irrigation_v1')
    AND json_valid(s.peer_capabilities_context_json)
    AND json_extract(s.peer_capabilities_context_json, '$.server_url') = s.server_url
    AND json_extract(s.peer_capabilities_context_json, '$.cloud_user_id') = s.cloud_user_id
    AND json_extract(s.peer_capabilities_context_json, '$.gateway_device_eui') = s.gateway_device_eui
    AND json_extract(s.peer_capabilities_context_json, '$.installation_uuid') = s.installation_uuid
    AND i.installation_uuid = s.installation_uuid
    AND i.current_gateway_device_eui = s.gateway_device_eui
)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'IRRIGATION_POLICY',
    NEW.policy_uuid,
    'IRRIGATION_POLICY_UPSERTED',
    json_object(
      'contract_version',            1,
      'policy_uuid',                 NEW.policy_uuid,
      'zone_uuid',                   NEW.zone_uuid,
      'condition',                   json(NEW.condition_json),
      'timezone',                    NEW.timezone,
      'enabled',                     NEW.enabled,
      'observation_window_minutes',  NEW.observation_window_minutes,
      'min_interval_minutes',        NEW.min_interval_minutes,
      'max_daily_minutes',           NEW.max_daily_minutes,
      'delivery_settings',           json(NEW.delivery_settings_json),
      'effective_from',              NEW.effective_from,
      'sync_version',                NEW.sync_version,
      'updated_at',                  NEW.updated_at,
      'deleted_at',                  NEW.deleted_at
    ),
    NEW.sync_version,
    COALESCE(NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    COALESCE(
      NULLIF(trim((SELECT z.gateway_device_eui FROM irrigation_zones z WHERE z.zone_uuid = NEW.zone_uuid AND z.deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT s.gateway_device_eui FROM sync_link_state s WHERE s.peer_node = 'cloud')), '')
    )
  );
END;

DROP TRIGGER IF EXISTS trg_sync_irrigation_policies_outbox_au;
CREATE TRIGGER trg_sync_irrigation_policies_outbox_au
AFTER UPDATE ON irrigation_policies
FOR EACH ROW
WHEN (
    COALESCE(NEW.zone_uuid,'')                      <> COALESCE(OLD.zone_uuid,'') OR
    COALESCE(NEW.condition_json,'')                 <> COALESCE(OLD.condition_json,'') OR
    COALESCE(NEW.timezone,'')                       <> COALESCE(OLD.timezone,'') OR
    COALESCE(NEW.enabled,0)                         <> COALESCE(OLD.enabled,0) OR
    COALESCE(NEW.observation_window_minutes,0)      <> COALESCE(OLD.observation_window_minutes,0) OR
    COALESCE(NEW.min_interval_minutes,0)            <> COALESCE(OLD.min_interval_minutes,0) OR
    COALESCE(NEW.max_daily_minutes,0)               <> COALESCE(OLD.max_daily_minutes,0) OR
    COALESCE(NEW.delivery_settings_json,'')          <> COALESCE(OLD.delivery_settings_json,'') OR
    COALESCE(NEW.effective_from,'')                 <> COALESCE(OLD.effective_from,'') OR
    COALESCE(NEW.sync_version,0)                    <> COALESCE(OLD.sync_version,0) OR
    COALESCE(NEW.updated_at,'')                     <> COALESCE(OLD.updated_at,'') OR
    COALESCE(NEW.deleted_at,'')                     <> COALESCE(OLD.deleted_at,'')
  )
  AND EXISTS (
    SELECT 1
    FROM sync_link_state s
    JOIN installation_identity i ON i.singleton_id = 1
    WHERE s.peer_node = 'cloud'
      AND s.linked = 1
      AND s.peer_capabilities_request_id IS NOT NULL
      AND trim(s.peer_capabilities_request_id) <> ''
      AND json_valid(s.peer_capabilities_json)
      AND json_type(s.peer_capabilities_json) = 'array'
      AND EXISTS (SELECT 1 FROM json_each(s.peer_capabilities_json) c WHERE c.value = 'conditional_irrigation_v1')
      AND json_valid(s.peer_capabilities_context_json)
      AND json_extract(s.peer_capabilities_context_json, '$.server_url') = s.server_url
      AND json_extract(s.peer_capabilities_context_json, '$.cloud_user_id') = s.cloud_user_id
      AND json_extract(s.peer_capabilities_context_json, '$.gateway_device_eui') = s.gateway_device_eui
      AND json_extract(s.peer_capabilities_context_json, '$.installation_uuid') = s.installation_uuid
      AND i.installation_uuid = s.installation_uuid
      AND i.current_gateway_device_eui = s.gateway_device_eui
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'IRRIGATION_POLICY',
    NEW.policy_uuid,
    'IRRIGATION_POLICY_UPSERTED',
    json_object(
      'contract_version',            1,
      'policy_uuid',                 NEW.policy_uuid,
      'zone_uuid',                   NEW.zone_uuid,
      'condition',                   json(NEW.condition_json),
      'timezone',                    NEW.timezone,
      'enabled',                     NEW.enabled,
      'observation_window_minutes',  NEW.observation_window_minutes,
      'min_interval_minutes',        NEW.min_interval_minutes,
      'max_daily_minutes',           NEW.max_daily_minutes,
      'delivery_settings',           json(NEW.delivery_settings_json),
      'effective_from',              NEW.effective_from,
      'sync_version',                NEW.sync_version,
      'updated_at',                  NEW.updated_at,
      'deleted_at',                  NEW.deleted_at
    ),
    NEW.sync_version,
    COALESCE(NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    COALESCE(
      NULLIF(trim((SELECT z.gateway_device_eui FROM irrigation_zones z WHERE z.zone_uuid = NEW.zone_uuid AND z.deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT s.gateway_device_eui FROM sync_link_state s WHERE s.peer_node = 'cloud')), '')
    )
  );
END;

DROP TRIGGER IF EXISTS trg_sync_valve_schedules_outbox_ai;
CREATE TRIGGER trg_sync_valve_schedules_outbox_ai
AFTER INSERT ON valve_schedules
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM sync_link_state s
  WHERE s.peer_node = 'cloud'
    AND s.linked = 1
    AND (
      (NEW.condition_policy_uuid IS NULL AND NEW.effective_from IS NULL)
      OR EXISTS (
        SELECT 1
        FROM installation_identity i
        WHERE i.singleton_id = 1
          AND s.peer_capabilities_request_id IS NOT NULL
          AND trim(s.peer_capabilities_request_id) <> ''
          AND json_valid(s.peer_capabilities_json)
          AND json_type(s.peer_capabilities_json) = 'array'
          AND EXISTS (SELECT 1 FROM json_each(s.peer_capabilities_json) c WHERE c.value = 'conditional_irrigation_v1')
          AND json_valid(s.peer_capabilities_context_json)
          AND json_extract(s.peer_capabilities_context_json, '$.server_url') = s.server_url
          AND json_extract(s.peer_capabilities_context_json, '$.cloud_user_id') = s.cloud_user_id
          AND json_extract(s.peer_capabilities_context_json, '$.gateway_device_eui') = s.gateway_device_eui
          AND json_extract(s.peer_capabilities_context_json, '$.installation_uuid') = s.installation_uuid
          AND i.installation_uuid = s.installation_uuid
          AND i.current_gateway_device_eui = s.gateway_device_eui
      )
    )
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
      'contract_version',       1,
      'schedule_uuid',          NEW.schedule_uuid,
      'device_eui',             NEW.device_eui,
      'kind',                   NEW.kind,
      'label',                  NEW.label,
      'weekdays_mask',          NEW.weekdays_mask,
      'start_time',             NEW.start_time,
      'fire_at',                NEW.fire_at,
      'duration_minutes',       NEW.duration_minutes,
      'timezone',               NEW.timezone,
      'enabled',                NEW.enabled,
      'once_state',             NEW.once_state,
      'condition_policy_uuid',  NEW.condition_policy_uuid,
      'effective_from',         NEW.effective_from,
      'deleted_at',             NEW.deleted_at,
      'sync_version',           NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(
      NULLIF(trim((SELECT d.gateway_device_eui FROM devices d WHERE UPPER(d.deveui) = UPPER(NEW.device_eui) AND d.deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT s.gateway_device_eui FROM sync_link_state s WHERE s.peer_node = 'cloud')), '')
    )
  );
END;

DROP TRIGGER IF EXISTS trg_sync_valve_schedules_outbox_au;
CREATE TRIGGER trg_sync_valve_schedules_outbox_au
AFTER UPDATE ON valve_schedules
FOR EACH ROW
WHEN (
    COALESCE(NEW.kind,'')                    <> COALESCE(OLD.kind,'') OR
    COALESCE(NEW.label,'')                   <> COALESCE(OLD.label,'') OR
    COALESCE(NEW.weekdays_mask,0)            <> COALESCE(OLD.weekdays_mask,0) OR
    COALESCE(NEW.start_time,'')              <> COALESCE(OLD.start_time,'') OR
    COALESCE(NEW.fire_at,'')                 <> COALESCE(OLD.fire_at,'') OR
    COALESCE(NEW.duration_minutes,0)         <> COALESCE(OLD.duration_minutes,0) OR
    COALESCE(NEW.timezone,'')                <> COALESCE(OLD.timezone,'') OR
    COALESCE(NEW.enabled,0)                  <> COALESCE(OLD.enabled,0) OR
    COALESCE(NEW.once_state,'')              <> COALESCE(OLD.once_state,'') OR
    COALESCE(NEW.condition_policy_uuid,'')   <> COALESCE(OLD.condition_policy_uuid,'') OR
    COALESCE(NEW.effective_from,'')          <> COALESCE(OLD.effective_from,'') OR
    COALESCE(NEW.deleted_at,'')              <> COALESCE(OLD.deleted_at,'') OR
    COALESCE(NEW.sync_version,0)             <> COALESCE(OLD.sync_version,0)
  )
  AND EXISTS (
    SELECT 1
    FROM sync_link_state s
    WHERE s.peer_node = 'cloud'
      AND s.linked = 1
      AND (
        (NEW.condition_policy_uuid IS NULL AND NEW.effective_from IS NULL)
        OR EXISTS (
          SELECT 1
          FROM installation_identity i
          WHERE i.singleton_id = 1
            AND s.peer_capabilities_request_id IS NOT NULL
            AND trim(s.peer_capabilities_request_id) <> ''
            AND json_valid(s.peer_capabilities_json)
            AND json_type(s.peer_capabilities_json) = 'array'
            AND EXISTS (SELECT 1 FROM json_each(s.peer_capabilities_json) c WHERE c.value = 'conditional_irrigation_v1')
            AND json_valid(s.peer_capabilities_context_json)
            AND json_extract(s.peer_capabilities_context_json, '$.server_url') = s.server_url
            AND json_extract(s.peer_capabilities_context_json, '$.cloud_user_id') = s.cloud_user_id
            AND json_extract(s.peer_capabilities_context_json, '$.gateway_device_eui') = s.gateway_device_eui
            AND json_extract(s.peer_capabilities_context_json, '$.installation_uuid') = s.installation_uuid
            AND i.installation_uuid = s.installation_uuid
            AND i.current_gateway_device_eui = s.gateway_device_eui
        )
      )
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
      'contract_version',       1,
      'schedule_uuid',          NEW.schedule_uuid,
      'device_eui',             NEW.device_eui,
      'kind',                   NEW.kind,
      'label',                  NEW.label,
      'weekdays_mask',          NEW.weekdays_mask,
      'start_time',             NEW.start_time,
      'fire_at',                NEW.fire_at,
      'duration_minutes',       NEW.duration_minutes,
      'timezone',               NEW.timezone,
      'enabled',                NEW.enabled,
      'once_state',             NEW.once_state,
      'condition_policy_uuid',  NEW.condition_policy_uuid,
      'effective_from',         NEW.effective_from,
      'deleted_at',             NEW.deleted_at,
      'sync_version',           NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(
      NULLIF(trim((SELECT d.gateway_device_eui FROM devices d WHERE UPPER(d.deveui) = UPPER(NEW.device_eui) AND d.deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT s.gateway_device_eui FROM sync_link_state s WHERE s.peer_node = 'cloud')), '')
    )
  );
END;
