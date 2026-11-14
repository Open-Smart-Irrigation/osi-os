'use strict';
// #636 rule (g): the record's fingerprints of new bodies for objects the
// installed payload's boot node recreates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootRecreatedObjects, createStatements, fingerprintOf, pendingBootOwnedFingerprints } = require('../boot-owned-fingerprints');
const { computeFingerprints } = require('../fingerprints');
const { cliRunner } = require('../runner-iface');
const { loadMigrationCorpus } = require('../migrations-loader');

const REPO = path.resolve(__dirname, '..', '..', '..');
const FLOWS = JSON.parse(fs.readFileSync(path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));
const MIGRATIONS = path.join(REPO, 'database/migrations/ordered');
const SQL_0073 = fs.readFileSync(path.join(MIGRATIONS, '0073__zone_env_rain_quality_sync.sql'), 'utf8');

test('the recreated objects come from the boot node\'s own DROP statements', () => {
  const objects = bootRecreatedObjects(FLOWS);
  assert.ok(objects.has('trigger trg_dp_zone_env_outbox_ai'));
  assert.ok(objects.has('trigger trg_dp_zone_env_outbox_au'));
  assert.ok(![...objects].some((o) => o.startsWith('table ')), 'tables are never dropped and recreated');
  assert.throws(() => bootRecreatedObjects([{ id: 'other', func: '' }]), /no sync-init-fn/);
});

test('CREATE TRIGGER is cut at its own END, past the CASE ... END inside its body', () => {
  const statements = createStatements(`${SQL_0073}\nCREATE INDEX IF NOT EXISTS idx_x ON t(a) WHERE b = 'END;';\n`);
  assert.deepEqual(statements.map((s) => `${s.type} ${s.name}`), [
    'trigger trg_dp_zone_env_outbox_ai', 'trigger trg_dp_zone_env_outbox_au', 'index idx_x',
  ]);
  for (const s of statements.filter((x) => x.type === 'trigger')) assert.match(s.sql, /END$/);
  assert.equal(statements[2].sql, "CREATE INDEX IF NOT EXISTS idx_x ON t(a) WHERE b = 'END;'");
});

test('a body\'s fingerprint equals the one computeFingerprints stamps for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-boot-owned-'));
  try {
    const db = path.join(dir, 'farming.db');
    fs.copyFileSync(path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db'), db);
    const live = await computeFingerprints(cliRunner(db));
    for (const s of createStatements(SQL_0073)) {
      const stamped = live.find((f) => f.object_type === s.type && f.object_name === s.name);
      assert.equal(fingerprintOf(s.type, s.sql), stamped.fingerprint, s.name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only pending migrations count, and a body equal to the current one is left out', () => {
  const migrations = loadMigrationCorpus(MIGRATIONS).migrations;
  const all = pendingBootOwnedFingerprints({ flows: FLOWS, migrations, appliedHead: 70, current: new Map() });
  assert.ok(all.some((o) => o.version === 73 && o.name === 'trg_dp_zone_env_outbox_ai'));
  assert.ok(all.every((o) => o.version > 70));
  assert.deepEqual(pendingBootOwnedFingerprints({ flows: FLOWS, migrations, appliedHead: 73, current: new Map() })
    .filter((o) => o.version === 73), []);
  const current = new Map(all.map((o) => [`${o.type} ${o.name}`, o.fingerprint]));
  assert.deepEqual(pendingBootOwnedFingerprints({ flows: FLOWS, migrations, appliedHead: 70, current }), []);
});
