'use strict';
// node --test wrapper for scripts/verify-boot-ddl-interpolation.js.
// Verifies the guard passes on the repo's fixed flows and still catches both
// historical defect classes (issue #4 escaped-quote interpolation, issue #10
// literal-0 sync_version) via synthetic regression fixtures.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyFlows } = require('./verify-boot-ddl-interpolation');

const repoRoot = path.resolve(__dirname, '..');
const CANONICAL = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
const SEED = path.join(repoRoot, 'database/seed-blank.sql');

function writeFixture(mutate) {
  const flows = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
  const node = flows.find((n) => n && n.id === 'sync-init-fn');
  node.func = mutate(node.func);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bootddl-')), 'flows.json');
  fs.writeFileSync(file, JSON.stringify(flows, null, 2) + '\n');
  return file;
}

test('repo flows pass on both profiles', () => {
  for (const flowsPath of [CANONICAL, MIRROR]) {
    const { failures } = verifyFlows(flowsPath, SEED);
    assert.deepStrictEqual(failures, [], `${flowsPath} unexpectedly failed: ${failures.join('; ')}`);
  }
});

test('escaped-quote gatewaySql interpolation (issue #4 shape) is caught', () => {
  const fixture = writeFixture((func) => {
    // Reintroduce the broken form into the dendro-daily AI trigger DDL string:
    // `" + gatewaySql + "` (close/concat/reopen) -> `\" + gatewaySql + \"`
    // (escaped quotes shipping the literal text into SQL).
    const target = 'trg_dp_dendro_daily_outbox_ai AFTER INSERT';
    const start = func.indexOf(target);
    assert.ok(start > -1, 'dendro AI trigger DDL not found in sync-init-fn');
    const end = func.indexOf('END;",', start);
    const segment = func.slice(start, end);
    const broken = segment.split('" + gatewaySql + "').join('\\" + gatewaySql + \\"');
    assert.notStrictEqual(segment, broken, 'fixture mutation did not change the DDL');
    return func.slice(0, start) + broken + func.slice(end);
  });
  const { failures } = verifyFlows(fixture, SEED);
  assert.ok(
    failures.some((f) => f.includes("literal 'gatewaySql'") || f.includes('statement failed')),
    `expected a gatewaySql-leak failure, got: ${failures.join('; ') || '(none)'}`
  );
});

test('literal-0 sync_version on an _UPSERTED trigger (issue #10 shape) is caught', () => {
  const fixture = writeFixture((func) => {
    const target = "'computed_at', NEW.computed_at, 'sync_version', NEW.sync_version), NEW.sync_version, strftime(";
    assert.ok(func.includes(target), 'fixed dendro/zone-recs payload tail not found in sync-init-fn');
    // Regress every versioned trigger tail back to the pre-fix literal-0 form.
    return func.split(target).join("'computed_at', NEW.computed_at), 0, strftime(");
  });
  const { failures } = verifyFlows(fixture, SEED);
  assert.ok(
    failures.some((f) => f.includes('passes literal 0 as sync_version')),
    `expected a literal-0 sync_version failure, got: ${failures.join('; ') || '(none)'}`
  );
});

test('a dropped-but-not-recreated versioned outbox trigger is caught', () => {
  const fixture = writeFixture((func) => {
    const target = '"CREATE TRIGGER trg_dp_zone_env_outbox_ai AFTER INSERT ON zone_daily_environment';
    const start = func.indexOf(target);
    assert.ok(start > -1, 'zone_env AI trigger DDL not found');
    const end = func.indexOf('END;",', start) + 'END;",'.length;
    return func.slice(0, start) + func.slice(end);
  });
  const { failures } = verifyFlows(fixture, SEED);
  assert.ok(
    failures.some((f) => f.includes('trg_dp_zone_env_outbox_ai: missing')),
    `expected a missing-trigger failure, got: ${failures.join('; ') || '(none)'}`
  );
});
