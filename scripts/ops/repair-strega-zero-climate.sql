-- Ops data repair: STREGA valve rows with a fabricated 0.0 C / 0 % RH pair.
--
-- Root cause: Build Telemetry (8809bb5239dfb3d4) and Process STREGA
-- (strega-process-fn) in flows.json defined `numberOrNull(value)` as
-- `Number.isFinite(Number(value)) ? Number(value) : null` with no upfront
-- null/''/undefined check. Since `Number(null) === 0` and `Number('') === 0`,
-- a STREGA Gen1 uplink with no enclosure climate sensor (vendor sentinel
-- FF FF FF FF in the temperature/humidity slot, correctly decoded by
-- strega_gen1_decoder.js to `Temperature: null, Hygrometry: null`) had that
-- null coerced to 0 before being persisted, so device_data.ambient_temperature
-- and device_data.relative_humidity ended up 0.0 / 0 instead of NULL. Fixed in
-- the same change that adds this script (numberOrNull now short-circuits on
-- null/undefined/'').
--
-- This script repairs ONLY historical rows already written with the bug. It
-- does not touch schema, does not enqueue sync events (see note below), and
-- is intentionally NOT a ledger migration:
--   - It is a one-off data correction against existing rows on specific
--     already-provisioned gateways, not a schema change (no
--     table/column/index/trigger DDL) and not something every gateway needs
--     applied automatically at deploy time.
--   - osi-schema-change-control's decision table restricts the ordered
--     migration runner ("data" risk class included) to changes that should
--     ship to every fleet gateway on next deploy. This repair is scoped to
--     gateways with actually-affected STREGA rows and is meant to be run
--     ops-side, by hand, after inspecting the preview below on the specific
--     gateway in question — not folded into the automatic deploy path.
--
-- Heuristic: a real STREGA enclosure with BOTH ambient_temperature = 0.0 AND
-- relative_humidity = 0.0 in the same row is physically implausible (0 % RH
-- never occurs in practice, and STREGA valves with no climate sensor always
-- report the sentinel for both fields together, never independently) — so
-- rows with both columns exactly 0 on a STREGA_VALVE device are treated as
-- sentinel artefacts of this bug and reset to NULL. Rows with only one of the
-- two columns at 0, or with any other non-zero reading, are left untouched.
--
-- IMPORTANT:
--   - Run the PREVIEW query first and eyeball the row count / device list
--     before running the UPDATE. Do not run this against a live gateway
--     without a fresh backup (see osi-live-ops-runbook).
--   - This does NOT enqueue sync events for the changed rows. Cloud-side
--     device_data rows for the same devices keep their existing 0.0/0 values
--     until a separate, explicit decision is made about whether/how to
--     correct the cloud mirror (out of scope for this script).
--   - Idempotent: rerunning after the first successful run updates zero rows,
--     because the WHERE clause only matches rows still at the 0/0 sentinel
--     pair.

-- === PREVIEW (run this first; inspect before running the UPDATE below) ===
SELECT
  dd.id,
  dd.deveui,
  d.name AS device_name,
  dd.recorded_at,
  dd.ambient_temperature,
  dd.relative_humidity
FROM device_data dd
JOIN devices d ON d.deveui = dd.deveui
WHERE d.type_id = 'STREGA_VALVE'
  AND dd.ambient_temperature = 0
  AND dd.relative_humidity = 0
ORDER BY dd.deveui, dd.recorded_at;

-- === REPAIR (idempotent; only affects rows matching the same predicate) ===
UPDATE device_data
SET ambient_temperature = NULL,
    relative_humidity = NULL
WHERE deveui IN (SELECT deveui FROM devices WHERE type_id = 'STREGA_VALVE')
  AND ambient_temperature = 0
  AND relative_humidity = 0;

-- === POST-CHECK (expect 0 rows) ===
SELECT COUNT(*) AS remaining_sentinel_rows
FROM device_data dd
JOIN devices d ON d.deveui = dd.deveui
WHERE d.type_id = 'STREGA_VALVE'
  AND dd.ambient_temperature = 0
  AND dd.relative_humidity = 0;
