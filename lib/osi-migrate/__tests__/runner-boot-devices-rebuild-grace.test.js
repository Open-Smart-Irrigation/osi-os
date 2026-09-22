'use strict';
// osi-os#221: does a Node-RED boot that rebuilds `devices` block the next
// migration run?
//
// History. Uganda refused 16 times on 2026-09-11/12. The refusal was NOT the
// `table|devices` diff #221's title assumes -- compareSchemas never emits
// {kind:'table', class:'changed'}; a table's contents surface as `column`,
// `check` and `foreign_key` diffs, and `table` diffs are only `missing`,
// `extra_forward` or `extra_unknown` (pinned in
// scripts/semantic-schema-compare.test.js). The diff the comparator actually
// reported was a single changed column: devices.chameleon_enabled, NOT NULL in
// the boot DDL against a nullable seed (#173).
//
// #219 is a different failure and this comparator CANNOT see it. The pre-#237
// boot DDL did declare the sdi12_* columns; it was the hardcoded 45-column
// positional copy statement that omitted them, so a rebuild dropped the column
// DATA while the rebuilt table still had the columns. Schema comparison is
// blind to that by construction. The guard for it is the seeded rehearsal in
// PR #237 (scripts/rehearse-devices-rebuild.js's `sdi12-sentinels` and
// `missing-source-columns` cases), plus the row witness asserted below.
//
// PR #237 removed both at the source by building the rebuild DDL and the copy
// statement from one seed-ordered DEVICES_COLUMNS table and introspecting the
// live column set inside the transaction.
//
// Characterisation result at migration head 0058: after a forced rebuild the
// live schema matches reference(head), including the 12 gateway attribution
// trigger bodies. The boot node and migration 0058 now use the same persisted
// sync_link_state fallback, so no trigger drift needs the v3 normaliser grace
// path. The normaliser remains covered by fingerprints-gateway-eui.test.js;
// gateway-eui-attribution.test.js mutates the fallback and proves trigger
// parity catches its removal.
//
// SCOPE LIMIT -- read before treating a pass here as "the schema is identical".
// These tests, and the runner grace path they characterise, can only see what
// scripts/semantic-schema-compare.js reports. The comparator:
//   - ignores physical column ORDER (snapshotSchema sorts columns by name);
//   - ignores every table in IGNORED_TABLES (schema_migrations,
//     schema_object_fingerprints, sqlite_sequence);
//   - ignores hidden/generated columns (PRAGMA table_xinfo, c.hidden);
//   - ignores COLUMN DATA and row contents entirely -- it reads sqlite_master
//     and PRAGMAs, never a row, so a rebuild that silently emptied a column
//     (the real #219 shape) is invisible to it;
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
  const { runner, diffs, boot, rowsBefore, rowsAfter } = await stampThenBoot({
    head: HEAD, deviceEui: UGANDA_EUI, forceRebuild: true });
  assert.deepEqual(boot.errors, [], 'the boot node must not report an error on a head-schema gateway');
  // The boot node's trigger loop swallows per-trigger failures into node.warn,
  // so an empty error list alone does not mean the boot pass was clean.
  assert.deepEqual(boot.warnings, [], 'the boot node must not warn either');

  // Not vacuous: the narrowed type_id CHECK proves the rebuild actually ran.
  // If the boot node ever stopped rebuilding, "no residual diff" would be
  // trivially true.
  const [{ sql }] = await runner.all(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'");
  assert.match(sql, /'AQUASCOPE_LORAIN'/, 'the boot node must converge the type it was drifted away from');
  assert.match(sql, /'DRAGINO_SDI12'/);

  // The comparator cannot see row data (see the SCOPE LIMIT above), so assert
  // it separately: every seeded device, its telemetry, and every column value
  // the old positional copy statement would have dropped must survive.
  assert.deepEqual(rowsAfter, rowsBefore,
    'the rebuild must preserve devices rows, device_data rows, and every column value');
  assert.equal(rowsAfter.deviceCount, 2, 'sanity: the harness seeded rows for the rebuild to carry');

  const residual = diffs.filter((d) => d.kind !== 'trigger');
  assert.deepEqual(residual, [],
    'a boot rebuild must leave no non-trigger diff: ' + JSON.stringify(residual, null, 2));
  assert.deepEqual(diffs, [],
    'a head-schema boot rebuild must leave no schema drift: ' + JSON.stringify(diffs));

  // #221 proper: the gate that refused on Uganda must now pass, with no
  // `restamp-fingerprints.js` run in between.
  await assert.doesNotReject(applyPending(runner, APPLY));
});

test('a devices rebuild that drops a column still refuses', SLOW, async () => {
  // Not sdi12_channel_layout_json: trg_sentek_device_outbox_payload_ai reads it,
  // so SQLite refuses that DROP COLUMN outright. dendro_baseline_pending has no
  // trigger or index reference in seed-blank.sql.
  const { runner, diffs } = await stampThenBoot({
    head: HEAD, deviceEui: UGANDA_EUI, forceRebuild: true,
    mutateAfterBoot: 'ALTER TABLE devices DROP COLUMN dendro_baseline_pending',
  });
  // runner.js's refusal message is generic, so it cannot attribute the refusal
  // on its own -- a pre-#237 payload refuses with the same string for a
  // different reason. The comparator diff is what names the cause, so assert
  // that this refusal is the dropped column and nothing else.
  const nonTrigger = diffs.filter((d) => d.kind !== 'trigger');
  assert.deepEqual(nonTrigger.map((d) => [d.class, d.kind, d.name]),
    [['missing', 'column', 'devices.dendro_baseline_pending']],
    'the only non-trigger diff must be the column this test dropped: ' + JSON.stringify(nonTrigger));
  assert.match(nonTrigger[0].detail, /dendro_baseline_pending|INTEGER/);
  await assert.rejects(applyPending(runner, APPLY), /schema drift detected/);
});

test('an unrelated schema change still refuses', SLOW, async () => {
  const { runner } = await stampThenBoot({
    head: HEAD, deviceEui: UGANDA_EUI,
    mutateAfterBoot: 'DROP INDEX IF EXISTS idx_devices_farm_id',
  });
  await assert.rejects(applyPending(runner, APPLY), /schema drift detected/);
});
