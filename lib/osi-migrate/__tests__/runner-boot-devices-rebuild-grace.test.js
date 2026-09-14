'use strict';
// osi-os#221: does a Node-RED boot that rebuilds `devices` block the next
// migration run?
//
// History. Uganda refused 16 times on 2026-09-11/12. The refusal was NOT the
// `table|devices` diff #221's title assumes -- compareSchemas never emits
// {kind:'table', class:'changed'}; a table's contents surface as `column`,
// `check` and `foreign_key` diffs, and `table` diffs are only `missing`,
// `extra_forward` or `extra_unknown` (pinned in
// scripts/semantic-schema-compare.test.js). The real diffs were a changed
// column (devices.chameleon_enabled: NOT NULL in the boot DDL, nullable in the
// seed -- #173) and missing columns (devices.sdi12_*, dropped by the hardcoded
// 45-column copy list -- #219). PR #237 removed both at the source by building
// the rebuild DDL and the copy statement from one seed-ordered DEVICES_COLUMNS
// table and introspecting the live column set inside the transaction.
//
// Characterisation result (2026-09-14, head 56, this file's first test): after
// a forced rebuild the live schema differs from reference(head) in exactly 12
// `changed` trigger bodies and NOTHING else. Those 12 are the boot-owned
// gateway-EUI/formatting rewrites isBootOwnedTriggerBodyDrift already tolerates
// under the v3 normaliser. No tolerance was added to runner.js, and none is
// warranted: a residual column/check/FK diff would be a real boot-DDL-vs-seed
// divergence to fix, not to launder.
//
// SCOPE LIMIT -- read before treating a pass here as "the schema is identical".
// These tests, and the runner grace path they characterise, can only see what
// scripts/semantic-schema-compare.js reports. The comparator:
//   - ignores physical column ORDER (snapshotSchema sorts columns by name);
//   - ignores every table in IGNORED_TABLES (schema_migrations,
//     schema_object_fingerprints, sqlite_sequence);
//   - ignores hidden/generated columns (PRAGMA table_xinfo, c.hidden);
//   - compares triggers, views and indexes as normalised text, not semantics.
// A boot pass that changed only those properties would pass here unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPending } = require('../runner');
const { stampThenBoot, headVersion, MIGRATIONS_DIR } = require('./helpers/boot-rehearsal');

const HEAD = headVersion();
const UGANDA_EUI = '0016C001F151B1D6';
const APPLY = { migrationsDir: MIGRATIONS_DIR, appVersion: 'test-boot-rebuild-grace', writersStopped: true };

// reference(head) is memoized per process by scripts/baseline-existing-db.js,
// but the first build replays all 56 ordered migrations through the real
// runner (~7 min); every later call in this file is a cache hit (~12 s).
const SLOW = { timeout: 1_200_000 };

test('stamp -> boot rebuild -> drift gate accepts without a manual restamp', SLOW, async () => {
  const { runner, diffs, boot } = await stampThenBoot({
    head: HEAD, deviceEui: UGANDA_EUI, forceRebuild: true });
  assert.deepEqual(boot.errors, [], 'the boot node must not report an error on a head-schema gateway');

  // Not vacuous: the narrowed type_id CHECK proves the rebuild actually ran.
  // If the boot node ever stopped rebuilding, "no residual diff" would be
  // trivially true.
  const [{ sql }] = await runner.all(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'");
  assert.match(sql, /'AQUASCOPE_LORAIN'/, 'the boot node must converge the type it was drifted away from');
  assert.match(sql, /'DRAGINO_SDI12'/);

  const residual = diffs.filter((d) => d.kind !== 'trigger');
  assert.deepEqual(residual, [],
    'a boot rebuild must leave no non-trigger diff: ' + JSON.stringify(residual, null, 2));
  assert.ok(diffs.every((d) => d.class === 'changed'),
    'every remaining diff must be a boot-owned trigger BODY rewrite, never a missing or extra object: '
    + JSON.stringify(diffs.filter((d) => d.class !== 'changed')));

  // #221 proper: the gate that refused on Uganda must now pass, with no
  // `restamp-fingerprints.js` run in between.
  await assert.doesNotReject(applyPending(runner, APPLY));
});

test('a devices rebuild that drops a column still refuses', SLOW, async () => {
  // Not sdi12_channel_layout_json: trg_sentek_device_outbox_payload_ai reads it,
  // so SQLite refuses that DROP COLUMN outright. dendro_baseline_pending has no
  // trigger or index reference in seed-blank.sql.
  const { runner } = await stampThenBoot({
    head: HEAD, deviceEui: UGANDA_EUI, forceRebuild: true,
    mutateAfterBoot: 'ALTER TABLE devices DROP COLUMN dendro_baseline_pending',
  });
  await assert.rejects(applyPending(runner, APPLY), /schema drift detected/);
});

test('an unrelated schema change still refuses', SLOW, async () => {
  const { runner } = await stampThenBoot({
    head: HEAD, deviceEui: UGANDA_EUI,
    mutateAfterBoot: 'DROP INDEX IF EXISTS idx_devices_farm_id',
  });
  await assert.rejects(applyPending(runner, APPLY), /schema drift detected/);
});
