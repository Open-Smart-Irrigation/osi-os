'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseSeedDevicesColumns, parseBootDevicesColumns, migrationAddedDevicesColumns,
} = require('./verify-devices-rebuild-fence');

const repo = path.resolve(__dirname, '..');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const bootFunc = (rel) =>
  (JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'))
    .find((n) => n.id === 'sync-init-fn') || {}).func || '';
const seedText = () => fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');

test('boot devices DDL matches the seed column-for-column, in order', () => {
  const seed = parseSeedDevicesColumns(seedText());
  assert.ok(seed.length > 40, 'sanity: the seed parser found the real devices table');
  for (const rel of FLOWS) {
    const boot = parseBootDevicesColumns(bootFunc(rel));
    assert.deepStrictEqual(boot.map((c) => c.name), seed.map((c) => c.name),
      `${rel}: devices column names or order differ from the seed`);
    seed.forEach((c, i) => assert.strictEqual(boot[i].ddl, c.ddl,
      `${rel}: devices.${c.name} declaration differs from the seed`));
  }
});

test('every migration-added devices column is in the boot DDL', () => {
  const added = migrationAddedDevicesColumns(path.join(repo, 'database/migrations/ordered'));
  assert.ok(added.has('sdi12_channel_layout_json'),
    'sanity: the parser sees 0029 ALTER TABLE devices ADD COLUMN');
  for (const rel of FLOWS) {
    const boot = new Set(parseBootDevicesColumns(bootFunc(rel)).map((c) => c.name));
    for (const col of added) {
      assert.ok(boot.has(col), `${rel}: boot DDL is missing migration-added devices.${col}`);
    }
  }
});

test('migrationAddedDevicesColumns ignores ALTERs on other tables', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'addcol-'));
  fs.writeFileSync(path.join(dir, '0001__x.sql'),
    '-- risk: additive\nALTER TABLE devices_audit ADD COLUMN nope TEXT;\n' +
    'ALTER TABLE devices ADD COLUMN yes_col TEXT;\n');
  assert.deepStrictEqual([...migrationAddedDevicesColumns(dir)], ['yes_col']);
});

test('the copy is built inside the transaction and refuses unknown live columns', () => {
  for (const rel of FLOWS) {
    const f = bootFunc(rel);
    assert.match(f, /t\.all\(\s*'PRAGMA table_info\(devices\)'\s*\)/,
      `${rel}: live column set must be read with t.all inside the rebuild transaction`);
    assert.match(f, /devices rebuild ABORTED: unknown live column/,
      `${rel}: an unknown live column must abort the rebuild, not be dropped`);
  }
});
