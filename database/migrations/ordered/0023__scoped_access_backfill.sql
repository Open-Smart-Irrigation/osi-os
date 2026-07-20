-- risk: data
-- 0023: Scoped access backfill (AgroLink), two idempotent jobs (spec §5.3):
-- 1. Assign user_uuid to any legacy user row missing one (the shipped
--    trg_sync_users_uuid_ai covers inserts; this closes the pre-trigger era).
-- 2. In-place-upgrade admin promotion: when at least one user exists and no
--    admin does, promote the lowest-id active account. On a fresh image the
--    users table is empty and both jobs are no-ops; the fresh-hub admin path
--    is registration-time bootstrap (spec §10/§13).

UPDATE users
   SET user_uuid = lower(hex(randomblob(16)))
 WHERE user_uuid IS NULL OR user_uuid = '';

UPDATE users
   SET role = 'admin'
 WHERE id = (SELECT MIN(id) FROM users WHERE disabled_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
