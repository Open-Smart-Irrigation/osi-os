# Common mistakes and maintenance

Part of the osi-schema-change-control skill; read SKILL.md first.

## Common mistakes

- **Assuming the migration runner runs on boot.** It runs during `deploy.sh`, not
  during Node-RED startup. A `destructive`/`data` migration will not run
  automatically on the next Pi boot.
- **Treating `sync-init-fn`'s 93 `ADD COLUMN`s as a template to copy.** Frozen
  legacy debt (81 redundant with the seed, per AGENTS.md), not a pattern to
  extend — new additive schema goes in an ordered migration, not ADD COLUMN #94.
- **Confusing "missing-only" with the actual guard semantics.** The `devices`
  rebuild guard is **set-equality**: an extra/drifted type must also trigger a
  rebuild-and-converge, not just a missing type. A weaker missing-only guard was
  a real P2 review finding caught before merge.
- **Blaming the boot DDL node for a "duplicate column" verifier failure without
  checking the test baseline first.** Issue #84 shows this exact misattribution
  happened and had to be corrected in writing.
- **Assuming `verify-migrations.js` covers all DDL provenance.** It validates
  ordered migration files; `verify-no-stray-ddl.js` is the guard for ad hoc DDL
  in `flows.json` and `deploy.sh`.
- **Updating `seed-blank.sql` (or one bundled DB) without the rest.** The
  verifiers above will catch it, but catching it in CI after the fact is more
  expensive than doing the "apply to all 7 copies + mirror" step in one commit.
- **Hand-writing SQL against `schema_object_fingerprints` or
  `schema_migrations`.** Both are runner-owned bookkeeping tables
  (`lib/osi-migrate/ledger.js`, `ensureLedger`), not part of `seed-blank.sql` or
  the bundled DBs. Exactly two sanctioned tools write these tables outside the
  runner: `restamp-fingerprints.js` (fingerprints only) and
  `baseline-existing-db.js` (semantic-gated ledger baseline + fingerprints;
  Option B Stage 0). Hand-editing either table directly remains forbidden.
  (`scripts/repair-sync-outbox-v2.js` is a sanctioned, temporary pre-baseline
  additive repair — not a ledger tool; delete it once the fleet is baselined.)
- **Forgetting the FK fence direction/order.** `PRAGMA foreign_keys` is a no-op
  inside an already-open transaction — set it `OFF` *before* `BEGIN`, restore it
  `ON` in a `finally` so it fires even when the rebuild throws.

## Provenance and maintenance

Re-run these to catch drift in the facts above:

```bash
node scripts/verify-migrations.js                      # migration file well-formedness + contiguous versions
node scripts/verify-seed-replay.js                      # migrations replay == seed-blank.sql
node scripts/verify-runtime-schema-parity.js            # boot node devices CHECK + triggers == seed
node scripts/verify-db-schema-consistency.js            # all 7 bundled DBs match hand-maintained contract
node scripts/verify-no-stray-ddl.js                     # no ad hoc DDL-marker drift in flows/deploy surfaces
node scripts/verify-profile-parity.js                   # bcm2712 == bcm2709 byte-for-byte
node scripts/test-journal-schema.js                     # 7 bundled DBs' journal-catalog ROW CONTENT == seed-built reference (only gate that checks row bytes)
node scripts/verify-agroscope-linkage.js                # journal catalog's vocab/activity/operation/device/unit linkages still match the partner institute SoilManageR template (both directions)
node scripts/verify-devices-rebuild-fence.js            # boot-node rebuild is still fail-closed
node --test scripts/rehearse-devices-rebuild.test.js    # boot-node rebuild behaves correctly against 4 seeded cases
node --test lib/osi-migrate/__tests__/*.test.js         # runner unit tests (risk classes, atomicity, drift preflight, partial-batch retry)
find . -name farming.db -not -path '*/node_modules/*'  | sort   # current bundled DB surface; investigate unexpected additions/removals
ls database/migrations/ordered/                         # current migration set; choose next contiguous NNNN dynamically
ls .github/workflows/ && cat .github/workflows/migrations.yml .github/workflows/verify-sync-flow.yml   # what CI actually gates (both workflows)
grep -rn "osi-migrate\|applyPending\|bootstrapFresh\|verifyHead" scripts/ lib/ deploy.sh conf/ feeds/chirpstack-openwrt-feed/apps/node-red/files/ --exclude-dir=node_modules   # re-confirm no on-device caller (covers flows.json + init files, not just *.js/*.sh)
```

The command list above is a maintenance recipe, not current proof. Re-run it
against the branch you are changing and paste fresh output in the PR or
execution report; old authoring-session outputs are not completion evidence.
