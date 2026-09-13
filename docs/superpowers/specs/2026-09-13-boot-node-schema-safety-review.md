# Adversarial review 1 of docs/superpowers/plans/2026-09-12-boot-node-schema-safety.md

Reviewer: Fable, 2026-09-13, verified against origin/main = 3eee141f5 (plan baseline 0c3bcd9e2 is stale; re-pin).
Verdict: NEEDS REVISION.

## F1 HIGH — Task 3 still silently drops live columns
Named INSERT … (DEVICES_COLUMNS) SELECT … copies only columns the boot node knows. A live column an older payload does not know (old-payload/new-schema pairing, the #222 ordering) is dropped with its data. Task 2's gate proves repo-current only.
Fix: introspect INSIDE the transaction with `t.all('PRAGMA table_info(devices)')` (tx scope exposes run/all/get/exec, osi-db-helper/index.js:80-92; fence forbids only `_db.*`). If `present` has any name not in DEVICES_COLUMNS → throw (ABORTED, table intact). Add rehearsal case `extra-live-column`.

## F2 HIGH — Task 6 targets a diff shape that cannot occur
`compareSchemas` never emits `{kind:'table', class:'changed'}`; table diffs surface as column/check/foreign_key (scripts/semantic-schema-compare.js:57-84,112-170). Uganda's `table|devices` refusal was `changed column chameleon_enabled` (#173) + `missing column sdi12_*` (#219). After Tasks 1+3, `isBootOwnedTriggerBodyDrift` (runner.js ~130-150) already returns true post-boot. The stamp→boot→accepts test passes BEFORE Step 3 exists.
Fix: Step 1 characterisation is decisive; delete Step 3 unless a named residual column/check/FK diff appears. Close #221 via Tasks 1+3 with the tests as guard. Add a scope note that the grace path is blind to what the comparator ignores.

## F3 HIGH — Task 1 premise wrong: boot DDL and seed also differ in column ORDER
Positions 24-27: boot `dendro_force_legacy, dendro_stroke_mm, dendro_ratio_at_retracted, dendro_ratio_at_extended`; seed `…retracted, …extended, force_legacy, stroke_mm`. Task 1's name-order test goes red and stays red; reordering the DDL alone misaligns today's positional DEVICES_COPY_SQL (INTEGER flags into REAL columns). Whitespace-collapse parser fails on seed's multi-line IN(...).
Fix: fold Tasks 1-3 into one commit (DDL + named copy from DEVICES_COLUMNS in seed order), or make Task 1 order-insensitive and let Task 3 own order. Compare per-column ddl under `normalizeSqlClause` (lib/osi-migrate/sql-normalize.js).

## F4 HIGH — Task 7 changes gateway_device_eui runtime semantics on unlinked gateways, unstated
Today `trg_sync_*_defaults_ai` stamp env DEVICE_EUI at insert. After 0057 the fallback is `sync_link_state.gateway_device_eui`, which is NULL on never-linked DBs (seed-blank.sql:1175-1185) and set NULL on unlink (flows.json `UPDATE sync_link_state SET linked=0,…,gateway_device_eui=NULL`). Rows inserted while unlinked stay NULL until next boot. At link the stored value is the link-scoped EUI (`al-link-finalize`, cf. LINK_GATEWAY_DEVICE_EUI node-red.init:174) which can differ from DEVICE_EUI.
Minor: `COALESCE(NULLIF(trim(...)),''),NULL)` ≡ `NULLIF(trim(...),'')`; v3 canonicaliser still rewrites the `,null` tail (fingerprints.js:127-130) — "v3 not load-bearing" is half true.
Fix: state semantics; add test (insert unlinked → NULL; boot backfill → filled; link → attribution value); decide whether link handler backfills devices/irrigation_zones; Stage-1 Silvan check (unlink → add device → relink → verify outbox attribution).

## F5 MEDIUM — Task 7 breaks a CI test and mis-describes another
- lib/osi-migrate/__tests__/fingerprints-gateway-eui.test.js:167-189 asserts totalSites===22 and differingStatements>0 over the real boot triggers → fails once gatewaySql leaves trigger bodies. Add to Task 7 file list; retire/rewrite in same commit.
- verify-trigger-body-parity.js is ALREADY a hard gate (exit 1, :170-171; wired in migrations.yml). Step 6 "promote advisory" is stale; replace with "update rule 1 GATEWAY_EUI_LITERALS, keep green".

## F6 MEDIUM — Task 4 scanner misses the ops artifacts that actually ran
Scope is scripts/ops/*.js; executed SQL is scripts/ops/*.sql. uganda-schema-rebuild-20260911.sql:171-172 does `DROP TABLE devices; ALTER TABLE devices_rebuild_20260911 RENAME TO devices` — the `_old|_new` regex never matches.
Fix: scan scripts/ops/*.sql; define swap as any `DROP TABLE <t>` where <t> is source or target of a RENAME TO in the same text.

## F7 MEDIUM — Stage 0 rehearses the wrong Uganda artifact
`farming.db.bak-2026-09-11T22-4*` are mid-incident copies, not the recovered head-56 DB. Rehearse on a fresh `.backup` taken now (production gateway → explicit per-turn go). Add disk-free preflight to stop table: 0057 is destructive so backupDb writes a full byte copy under /data/backups/migrate on top of the pre-deploy backup.

## F8 MEDIUM — Size-ratchet re-pin names the wrong file
Ratchet is git-anchored to origin/main with per-node allowances in scripts/verify-flows-size-ratchet-allowances.json and -baseline.json via --write-baseline (verify-flows-size-ratchet.js:24-38,90-138). Name the allowance entry (node id, delta, reason); DEVICES_COLUMNS (~45×100 B) is not offset by Task 8's ~700 B deletion; total_allowance needed too.

## F9 LOW — Vacuous-test hazards (#182 class)
- verify-devices-rebuild-fence.js has no module.exports and process.exit at top level; require() from a test runs the CLI and exits 0. Make run()/exports refactor an explicit Step 0.
- New test files (verify-devices-rebuild-fence.test.js, verify-rename-swap-fence.test.js, verify-init-log-capture.test.js) must be added to migrations.yml's node --test list.
- Rehearsal harness already has 5 cases (sdi12-sentinels), not 4; expected after Task 3 is 7.

## F10 LOW — Misc
- Task 8: verify-no-stray-ddl.js has a writable_schema marker (:48); run in Task 8's gate. Fleet probes on Uganda/kaba100 need explicit per-turn consent.
- Task 5 is sound (deploy.sh:585-590 installs /etc/init.d/node-red; deploy-fetch-list.test.js:61 covers it).
- Task 7 risk class destructive is correct; postflight foreign_key_check runs for every class.
- Wave-3-after-Wave-2 justification collapses with F2.

Top 3: (1) F1 introspect inside tx + abort on unknown live column; (2) F2 rewrite Task 6 around real diff kinds, close #221 via Tasks 1+3; (3) F3 merge Tasks 1-3, and F4/F5 for Task 7.
