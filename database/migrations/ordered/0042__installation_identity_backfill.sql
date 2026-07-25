-- risk: data
-- Give already-provisioned gateways a stable installation identity.

INSERT INTO installation_identity(
  singleton_id,
  installation_uuid,
  current_gateway_device_eui,
  previous_gateway_device_euis_json,
  recovery_state,
  created_at,
  updated_at
)
SELECT
  1,
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  ),
  (
    SELECT upper(trim(gateway_device_eui))
    FROM sync_link_state
    WHERE peer_node = 'cloud'
      AND gateway_device_eui IS NOT NULL
      AND trim(gateway_device_eui) <> ''
  ),
  '[]',
  'ACTIVE',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM users)
   OR EXISTS (SELECT 1 FROM devices)
   OR EXISTS (SELECT 1 FROM irrigation_zones)
   OR EXISTS (
     SELECT 1
     FROM sync_link_state
     WHERE linked = 1
   );

UPDATE sync_link_state
SET installation_uuid = (
  SELECT installation_uuid
  FROM installation_identity
  WHERE singleton_id = 1
)
WHERE EXISTS (
  SELECT 1
  FROM installation_identity
  WHERE singleton_id = 1
);
