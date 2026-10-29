# Walkthrough: adding a column

Part of the osi-schema-change-control skill; read SKILL.md first.

## Walkthrough: adding a column end-to-end

This is the additive case (new column/table/index/trigger). For a CHECK
change or table rebuild, everything below still applies but you are in
`destructive`-class territory (writers-stopped gate, FK fence) — do not attempt
that live without also reading `osi-live-ops-runbook`.

1. **Write the migration.** Run `ls database/migrations/ordered/`, choose the
   next contiguous four-digit version after the highest existing migration, and
   create `database/migrations/ordered/NNNN__your_slug.sql` with a
   `-- risk: additive` header as the first line, then your
   `CREATE TABLE`/`ALTER TABLE ... ADD COLUMN`/`CREATE INDEX`/`CREATE TRIGGER`
   statements. Prefer `IF NOT EXISTS` on object-creation statements (tables,
   indexes, triggers) so the file is safely re-runnable, matching the `0002`
   precedent. `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` in SQLite, but
   live-Pi delivery still goes through the ordered migration runner; do not add a
   deploy-time `ensure_*` duplicate-column wrapper.
2. **Update `database/seed-blank.sql`.** Append the equivalent DDL so a fresh
   database created from the seed ends up schema-identical to one built by
   replaying all ordered migrations. `verify-seed-replay.js` is the automatic
   check for this; don't skip manual review just because the verifier exists.
3. **Regenerate all 7 bundled `farming.db` copies.** Apply your new migration
   file to each of the six non-mirrored copies with the `sqlite3` CLI, then copy
   the `bcm2712` full profile's DB over the `bcm2709` mirror so profile parity
   stays byte-for-byte (this is the exact pattern used for `0002`):
   ```bash
   MIGRATION=database/migrations/ordered/NNNN__your_slug.sql
   cd "$(git rev-parse --show-toplevel)" && for db in \
     conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
     conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
     conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
     conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
     database/farming.db \
     web/react-gui/farming.db
   do sqlite3 -bail "$db" < "$MIGRATION" && echo "OK $db"; done \
     && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
           conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
     && echo "OK mirror copy"
   ```
4. **Extend `scripts/verify-db-schema-consistency.js`'s hand-maintained
   `schemaContract`** (and `requiredIndexes`/`requiredTriggerSqlFragments` if
   applicable) with the new column/table/index so this widest verifier actually
   enforces the new shape going forward — it does not infer the contract from
   the migration file.
5. **Add TypeScript types** in `web/react-gui/src/types/farming.ts` if the new
   column/table is GUI-visible.
6. **Live Pi delivery is deploy-runner delivery.** Do not add or extend
   `deploy.sh` `ensure_*` functions. `deploy.sh` fetches and runs the ordered
   migrations, so the migration file is the live repair path for already
   provisioned Pis.
7. **Run the verifier set** and confirm each prints its OK line:
   ```bash
   node scripts/verify-migrations.js
   node scripts/verify-seed-replay.js
   node scripts/verify-runtime-schema-parity.js
   node scripts/verify-db-schema-consistency.js
   node scripts/verify-no-stray-ddl.js
   node scripts/verify-profile-parity.js
   node scripts/test-journal-schema.js   # MANDATORY for journal-catalog changes
   node scripts/verify-agroscope-linkage.js   # MANDATORY for journal-catalog changes: guards the catalog against partner-institute-template drift; CI-gated via .github/workflows/field-journal.yml
   ```
   `test-journal-schema.js` is the **only** gate that compares the 7 bundled DBs'
   journal-catalog **row content** (`journal_templates`/`layouts`/`vocab`
   `definition_json` etc.) against the seed-built reference. The others check
   schema/DDL and fingerprints, not row bytes — so a bundled DB carrying a stale
   catalog row (e.g. built from an in-progress draft, then never re-baked against
   the final migration) passes every other gate silently. If you touched
   `journal-catalog-core.js`, a catalog migration, or any bundled `farming.db`,
   this must print `test-journal-schema: OK`. (This gap shipped a real
   `full_record@6` drift in `be363f89`; see the git history of the 7 seed DBs.)
   If your change also touches `sync-init-fn` or the `devices` CHECK, add:
   ```bash
   node scripts/verify-devices-rebuild-fence.js
   node --test scripts/rehearse-devices-rebuild.test.js
   ```
8. **Both-profile parity.** Confirm `bcm2712` and `bcm2709` payload files
   (flows.json, bundled DB) are still byte-identical —
   `verify-profile-parity.js` in step 7 already covers this; do not hand-wave it.
9. **PR evidence per `docs/engineering-playbook.md` §8** ("Definition of done"):
   re-verify the original issue/claim against current code, keep the written
   plan and its review in the repo, include every gate's real output as re-run
   by a non-author, confirm both profiles/seeds are in parity, and write the PR
   body with root cause, tradeoffs, and evidence — not just a green checkmark.
