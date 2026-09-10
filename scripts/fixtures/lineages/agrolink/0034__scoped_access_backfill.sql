-- risk: data
-- 0034: Scoped access backfill (AgroLink).

UPDATE users
   SET user_uuid = lower(hex(randomblob(16)))
 WHERE user_uuid IS NULL OR user_uuid = '';

UPDATE users
   SET sync_version = 1
 WHERE sync_version < 1;

UPDATE users
   SET role = 'admin',
       sync_version = sync_version + 1
 WHERE id = (SELECT MIN(id) FROM users WHERE disabled_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
