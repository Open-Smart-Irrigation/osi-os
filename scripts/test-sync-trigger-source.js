'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const generator = require('./generate-sync-trigger-source.js');

function writeFlow(flowPath, mutate) {
  const flow = JSON.parse(fs.readFileSync(generator.FLOW_PATHS[0], 'utf8'));
  mutate(flow);
  fs.writeFileSync(flowPath, `${JSON.stringify(flow, null, 2)}\n`);
}

test('canonical source covers both runtime DDL owners and is deterministic', () => {
  const first = generator.referenceSnapshot({ flowPaths: [generator.FLOW_PATHS[0], generator.FLOW_PATHS[0]] });
  const second = generator.referenceSnapshot({ flowPaths: [generator.FLOW_PATHS[0], generator.FLOW_PATHS[0]] });
  assert.equal(first.triggers.length, 31);
  assert.deepEqual(first, second);
  assert.deepEqual(first, generator.loadCanonical());
  assert.equal(new Set(first.triggers.map((entry) => entry.name)).size, 31);
  assert.ok(first.triggers.some((entry) => entry.name === 'sync_dendro_to_readings'));
  assert.ok(first.triggers.some((entry) => entry.name === 'trg_sync_zones_defaults_ai'));
  for (const owner of first.owners) {
    assert.ok(owner.statements.some((entry) => entry.kind === 'drop'));
    assert.ok(owner.statements.some((entry) => entry.kind === 'create'));
  }
});

test('one canonical definition renders both maintained profile regions', () => {
  const source = generator.loadCanonical();
  const current = fs.readFileSync(generator.FLOW_PATHS[0], 'utf8');
  assert.equal(generator.renderProfiles(source, [generator.FLOW_PATHS[0]]), current);
  const changed = JSON.parse(JSON.stringify(source));
  const entry = changed.triggers.find((candidate) => candidate.name === 'sync_dendro_to_readings');
  entry.sql = entry.sql.replace('ROUND(NEW.dendro_position_mm*1000)', 'ROUND(NEW.dendro_position_mm*1000)+1');
  assert.notEqual(generator.renderProfiles(changed, [generator.FLOW_PATHS[0]]), current);
});

test('check rejects a real trigger-body mutation and a missing delayed DROP', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-trigger-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const flowPath = path.join(dir, 'flows.json');
  const seedPath = path.join(dir, 'seed.sql');
  const canonicalPath = path.join(dir, 'canonical.json');
  fs.copyFileSync(path.join(path.dirname(__dirname), 'database/seed-blank.sql'), seedPath);
  fs.copyFileSync(generator.FLOW_PATHS[0], flowPath);

  const baseline = generator.referenceSnapshot({ seedPath, flowPaths: [flowPath, flowPath] });
  generator.writeCanonical(baseline, canonicalPath);

  writeFlow(flowPath, (flow) => {
    const sync = flow.find((entry) => entry.id === 'sync-init-fn');
    const before = sync.func;
    sync.func = before.replace(
      'UPDATE users SET user_uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;',
      'UPDATE users SET user_uuid = lower(hex(randomblob(16))) WHERE id = NEW.id; SELECT 1;'
    );
    assert.notEqual(sync.func, before);
  });
  assert.throws(
    () => generator.checkCanonical(canonicalPath, { seedPath, flowPaths: [flowPath, flowPath] }),
    /generated trigger regions are stale/
  );

  fs.copyFileSync(generator.FLOW_PATHS[0], flowPath);
  writeFlow(flowPath, (flow) => {
    const dendro = flow.find((entry) => entry.id === 'dendro-compute-fn');
    const before = dendro.func;
    dendro.func = before.replace('  `DROP TRIGGER IF EXISTS sync_dendro_to_readings`,\n', '');
    assert.notEqual(dendro.func, before);
  });
  assert.throws(
    () => generator.checkCanonical(canonicalPath, { seedPath, flowPaths: [flowPath, flowPath] }),
    /DROP/
  );
});
