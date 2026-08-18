-- risk: additive
-- 0028: Per-device learned SDI-12 reading count (task A6, wave-1 fix). Verified
-- SQLite 3.53 accepts a column-level CHECK on ALTER TABLE ADD COLUMN for a
-- single-column, non-foreign-key constraint (confirmed against this checkout's
-- sqlite3 CLI before writing this file); no prior precedent for this pattern
-- in the existing migration set, so this comment records the verification.
--
-- Also extends trg_sync_devices_outbox_au (watched-column list + payload_json)
-- to mirror sdi12_probe_profile's existing sync treatment. trg_sync_devices_outbox_au
-- is BOOT-OWNED: the Node-RED "Sync Init Schema + Triggers" node (sync-init-fn)
-- unconditionally DROPs + CREATEs this exact trigger from its own embedded
-- literal on every single restart, regardless of what this migration does.
-- The correct precedent for changing THIS trigger is commit bdaa6faf
-- (migration 0016__device_chameleon_sync.sql, chameleon_enabled) and migration
-- 0046__add_dragino_sdi12_type.sql (sdi12_probe_profile): both recreate the
-- trigger here AND update conf/.../flows.json's sync-init-fn literal in the
-- SAME commit -- NOT migration 0045, which never touches this trigger at all
-- (0045 only added the raw columns; 0046, immediately following in the same
-- commit 6d8dae60, is what actually wired sdi12_probe_profile into the trigger).
--
-- The CREATE TRIGGER body below is copied byte-for-byte (only line-wrapped at
-- existing " OR " boundaries, which lib/osi-migrate's fingerprint normalizer
-- collapses back to a single space, verified) from sync-init-fn's literal in
-- both flows.json profiles, updated in the SAME commit as this migration. This
-- is NOT cosmetic: lib/osi-migrate/fingerprints.js normalizes trigger SQL by
-- collapsing whitespace RUNS only -- it does not reformat token spacing -- so
-- a trigger recreated here with different spacing than the boot literal
-- (e.g. this codebase's usual "peer_node = 'cloud'" hand-formatting vs the
-- boot literal's "peer_node='cloud'") fingerprints differently even though the
-- SQL is semantically identical. A hand-formatted CREATE TRIGGER here would
-- stamp a fingerprint that boot's very next restart immediately invalidates,
-- and the NEXT migration's drift preflight would then refuse to proceed with
-- "schema drift detected" against a live schema that is actually correct --
-- confirmed by rehearsal (see task A6's execution report): a migration that
-- either omits the trigger entirely or recreates it with mismatched spacing
-- both reproduce this failure; only a byte-exact match against the boot
-- literal (as below) verifies clean across a simulated restart.
--
-- CAVEAT (Fable A6 review, advisory, verified by rehearsal): "byte-exact
-- match" above holds ONLY on a gateway whose DEVICE_EUI is Silvan's
-- (0016C001F11715E2). The boot literal computes gatewaySql live from
-- env.get('DEVICE_EUI') on every restart and inlines it as the
-- gateway_device_eui COALESCE fallback in TWO places in this trigger body;
-- this migration and seed-blank.sql instead hardcode the literal string
-- '0016C001F11715E2', matching only that one gateway. A rehearsal against
-- a different DEVICE_EUI (e.g. Uganda's 0016C001F151B1D6) reproduces
-- "schema drift detected" on the very first post-deploy restart, same as
-- the mismatched-spacing case above. This is a PRE-EXISTING gap, not
-- introduced here: migration 0046 hardcodes the same literal EUI in its own
-- CREATE TRIGGER for the identical reason, and every other boot-owned
-- trigger with a gateway_device_eui fallback shares it. It is the
-- osi-os#153 class of issue (boot literals diverging from migration-stamped
-- fingerprints), pre-existing since 0046/6d8dae60, out of scope for this
-- migration to fix generally -- flagged here so this file's own byte-exact
-- claim is not read as broader than it is.

ALTER TABLE devices ADD COLUMN sdi12_value_count INTEGER
  CHECK(sdi12_value_count IS NULL OR (sdi12_value_count BETWEEN 1 AND 8));

DROP TRIGGER IF EXISTS trg_sync_devices_outbox_au;

CREATE TRIGGER trg_sync_devices_outbox_au AFTER UPDATE ON devices FOR EACH ROW WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node='cloud' AND linked=1) AND (COALESCE(NEW.user_id,'') <> COALESCE(OLD.user_id,'') OR
    COALESCE(NEW.irrigation_zone_id,'') <> COALESCE(OLD.irrigation_zone_id,'') OR
    COALESCE(NEW.dendro_enabled,0) <> COALESCE(OLD.dendro_enabled,0) OR
    COALESCE(NEW.temp_enabled,0) <> COALESCE(OLD.temp_enabled,0) OR
    COALESCE(NEW.rain_gauge_enabled,0) <> COALESCE(OLD.rain_gauge_enabled,0) OR
    COALESCE(NEW.flow_meter_enabled,0) <> COALESCE(OLD.flow_meter_enabled,0) OR
    COALESCE(NEW.is_reference_tree,0) <> COALESCE(OLD.is_reference_tree,0) OR
    COALESCE(NEW.name,'') <> COALESCE(OLD.name,'') OR
    COALESCE(NEW.strega_model,'') <> COALESCE(OLD.strega_model,'') OR
    COALESCE(NEW.sdi12_probe_profile,'') <> COALESCE(OLD.sdi12_probe_profile,'') OR
    COALESCE(NEW.sdi12_value_count,-1) <> COALESCE(OLD.sdi12_value_count,-1) OR
    COALESCE(NEW.soil_moisture_probe_depths_json,'') <> COALESCE(OLD.soil_moisture_probe_depths_json,'') OR
    COALESCE(NEW.soil_moisture_probe_depths_configured,0) <> COALESCE(OLD.soil_moisture_probe_depths_configured,0) OR
    COALESCE(NEW.chameleon_enabled,0) <> COALESCE(OLD.chameleon_enabled,0) OR
    COALESCE(NEW.chameleon_swt1_depth_cm,-1) <> COALESCE(OLD.chameleon_swt1_depth_cm,-1) OR
    COALESCE(NEW.chameleon_swt2_depth_cm,-1) <> COALESCE(OLD.chameleon_swt2_depth_cm,-1) OR
    COALESCE(NEW.chameleon_swt3_depth_cm,-1) <> COALESCE(OLD.chameleon_swt3_depth_cm,-1) OR
    COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'') OR
    COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)) BEGIN INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui) VALUES (lower(hex(randomblob(16))), 'DEVICE', NEW.deveui, CASE WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN 'DEVICE_UNCLAIMED' WHEN COALESCE(OLD.irrigation_zone_id,'') <> COALESCE(NEW.irrigation_zone_id,'') AND NEW.irrigation_zone_id IS NULL THEN 'DEVICE_UNASSIGNED' WHEN COALESCE(OLD.irrigation_zone_id,'') <> COALESCE(NEW.irrigation_zone_id,'') AND NEW.irrigation_zone_id IS NOT NULL THEN 'DEVICE_ASSIGNED' ELSE 'DEVICE_FLAGS_UPDATED' END, json_object('contract_version', 1, 'device_eui', NEW.deveui, 'name', NEW.name, 'type', NEW.type_id, 'claimed_user_uuid', (SELECT user_uuid FROM users WHERE id = NEW.user_id), 'claimed_by_username', (SELECT COALESCE(server_username, username) FROM users WHERE id = NEW.user_id), 'zone_uuid', (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.irrigation_zone_id AND deleted_at IS NULL), 'dendro_enabled', NEW.dendro_enabled, 'temp_enabled', NEW.temp_enabled, 'rain_gauge_enabled', NEW.rain_gauge_enabled, 'flow_meter_enabled', NEW.flow_meter_enabled, 'is_reference_tree', NEW.is_reference_tree, 'current_state', NEW.current_state, 'target_state', NEW.target_state, 'strega_model', NEW.strega_model, 'sdi12_probe_profile', NEW.sdi12_probe_profile, 'sdi12_value_count', NEW.sdi12_value_count, 'soil_moisture_probe_depths_json', json(COALESCE(NEW.soil_moisture_probe_depths_json, '{}')), 'soil_moisture_probe_depths_configured', COALESCE(NEW.soil_moisture_probe_depths_configured, 0), 'chameleon_enabled', NEW.chameleon_enabled, 'chameleon_swt1_depth_cm', NEW.chameleon_swt1_depth_cm, 'chameleon_swt2_depth_cm', NEW.chameleon_swt2_depth_cm, 'chameleon_swt3_depth_cm', NEW.chameleon_swt3_depth_cm, 'gateway_device_eui', COALESCE(NEW.gateway_device_eui, '0016C001F11715E2'), 'sync_version', NEW.sync_version, 'deleted_at', NEW.deleted_at), NEW.sync_version, strftime('%Y-%m-%dT%H:%M:%fZ','now'), COALESCE(NEW.gateway_device_eui, '0016C001F11715E2')); END;
