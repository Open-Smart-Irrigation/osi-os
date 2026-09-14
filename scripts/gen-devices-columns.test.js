'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { regenerateFunc, seedColumns, seedDefault, shippedTable } = require('./gen-devices-columns');

const repo = path.resolve(__dirname, '..');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const bootFunc = (rel) =>
  JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8')).find((n) => n.id === 'sync-init-fn').func;
const seedText = () => fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');

test('regenerating reproduces the shipped DEVICES_COLUMNS byte for byte, in both profiles', () => {
  const seed = seedText();
  for (const rel of FLOWS) {
    const func = bootFunc(rel);
    assert.strictEqual(regenerateFunc(func, seed), func,
      `${rel}: DEVICES_COLUMNS is stale - run node scripts/gen-devices-columns.js`);
  }
});

test('a column added to the seed appears in the regenerated table with its seed default', () => {
  const seed = seedText().replace(
    '  sdi12_channel_layout_json             TEXT,\n',
    '  sdi12_channel_layout_json             TEXT,\n  brand_new_flag                        INTEGER DEFAULT 0,\n');
  const table = shippedTable(regenerateFunc(bootFunc(FLOWS[0]), seed));
  const added = table.get('brand_new_flag');
  assert.ok(added, 'a seed column new to the boot node must be generated');
  assert.strictEqual(added.ddl, 'brand_new_flag INTEGER DEFAULT 0');
  assert.deepStrictEqual(added.from, ['brand_new_flag'], 'a new column copies from itself');
  assert.strictEqual(added.dflt, '0', "a new column's dflt comes from the seed DEFAULT");
});

test('a seed column with no DEFAULT and no prior entry falls back to NULL', () => {
  const seed = seedText().replace(
    '  sdi12_channel_layout_json             TEXT,\n',
    '  sdi12_channel_layout_json             TEXT,\n  brand_new_note                        TEXT,\n');
  const added = shippedTable(regenerateFunc(bootFunc(FLOWS[0]), seed)).get('brand_new_note');
  assert.strictEqual(added.dflt, 'NULL');
});

test('legacy dendrometer fallbacks survive regeneration (they are not derivable from the seed)', () => {
  const table = shippedTable(regenerateFunc(bootFunc(FLOWS[0]), seedText()));
  assert.deepStrictEqual(table.get('dendro_ratio_at_retracted').from,
    ['dendro_ratio_at_retracted', 'dendro_ratio_zero']);
  assert.deepStrictEqual(table.get('dendro_ratio_at_extended').from,
    ['dendro_ratio_at_extended', 'dendro_ratio_span']);
});

test('every seed NOT NULL column gets a non-NULL dflt', () => {
  const table = shippedTable(regenerateFunc(bootFunc(FLOWS[0]), seedText()));
  for (const col of seedColumns(seedText())) {
    if (!/NOT\s+NULL/i.test(col.ddl)) continue;
    assert.notStrictEqual(table.get(col.name).dflt, 'NULL',
      `devices.${col.name} is NOT NULL, so its dflt may not be NULL`);
  }
});

test('seedDefault reads a literal DEFAULT and ignores DEFAULT NULL', () => {
  assert.strictEqual(seedDefault('sync_version INTEGER DEFAULT 0'), '0');
  assert.strictEqual(seedDefault('device_mode INTEGER DEFAULT 1'), '1');
  assert.strictEqual(seedDefault("label TEXT DEFAULT 'x'"), "'x'");
  assert.strictEqual(seedDefault('note TEXT'), null);
  assert.strictEqual(seedDefault('note TEXT DEFAULT NULL'), null);
});
