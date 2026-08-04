-- The version-scoped runtime audit runs before this schema-neutral marker.
-- Keeping this migration append-only preserves the live schema fingerprint.
SELECT 1;
