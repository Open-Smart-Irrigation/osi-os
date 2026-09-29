-- risk: data
-- 0064__fao56_stage_keys.sql: legacy vine-flavoured stage keys become FAO-56
-- growth stages. Only live rows whose normalised value changes are touched,
-- and each of those gets a new sync_version and updated_at, because the zone
-- outbox trigger emits ZONE_CONFIG_UPSERTED for a stage change and the cloud
-- rejects a changed payload that carries a version it already holds.
UPDATE irrigation_zones
   SET phenological_stage = CASE lower(trim(phenological_stage))
         WHEN 'budbreak' THEN 'initial' WHEN 'bud_break' THEN 'initial'
         WHEN 'fruitset' THEN 'development' WHEN 'cell_division' THEN 'development' WHEN 'cell_expansion' THEN 'development'
         WHEN 'veraison' THEN 'mid_season' WHEN 'fruit_maturation' THEN 'mid_season'
         WHEN 'harvest' THEN 'late_season' WHEN 'post_harvest' THEN 'late_season'
       END,
       sync_version = sync_version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE lower(trim(COALESCE(phenological_stage,''))) IN
       ('budbreak','bud_break','fruitset','cell_division','cell_expansion','veraison','fruit_maturation','harvest','post_harvest')
   AND deleted_at IS NULL;
