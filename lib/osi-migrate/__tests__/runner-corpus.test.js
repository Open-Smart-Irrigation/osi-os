'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { applyPending, bootstrapFresh, verifyHead } = require('../index');
const { cliRunner } = require('../runner-iface');
const { loadMigrationCorpus, materializeMigrations, resolveCorpus } = require('../migrations-loader');
const { writeFixture } = require('./helpers/migration-fixture');
const sql = (t) => `-- risk: additive\nCREATE TABLE ${t}(id INTEGER PRIMARY KEY);\n`;
const files = { '0001__a.sql': sql('a'), '0002__b.sql': sql('b'), '0003__c.sql': sql('c') };
const corruptions = {
  missing: (d) => fs.unlinkSync(path.join(d, '0003__c.sql')),
  mismatch: (d) => fs.appendFileSync(path.join(d, '0003__c.sql'), '-- changed\n'),
  extra: (d) => fs.writeFileSync(path.join(d, '0004__d.sql'), sql('d')),
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi397-test-'));
  const dir = path.join(root, 'm');
  fs.mkdirSync(dir);
  writeFixture(dir, files);
  return { root, dir, db: path.join(root, 't.db') };
}

async function dump(r) {
  const schema = await r.all(
    "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
  );
  const tables = {};
  for (const x of schema.filter((x) => x.type === 'table'))
    tables[x.name] = await r.all(`SELECT * FROM "${x.name}" ORDER BY rowid`);
  return { schema, tables };
}

for (const [kind, corrupt] of Object.entries(corruptions))
  for (const fn of [applyPending, bootstrapFresh, verifyHead])
    test(`${fn.name} refuses ${kind} before DB calls`, async () => {
      const { root, dir, db } = fixture();
      try {
        corrupt(dir);
        let calls = 0;
        const r = {
          dbPath: db,
          all: async () => {
            calls++;
            assert.fail('DB touched');
          },
          exec: async () => {
            calls++;
            assert.fail('DB touched');
          },
        };
        await assert.rejects(() => fn(r, { migrationsDir: dir, appVersion: 'test' }), {
          code: 'ERR_MIGRATION_CORPUS',
        });
        assert.equal(calls, 0);
        assert.equal(fs.existsSync(db), false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

for (const [kind, corrupt] of Object.entries(corruptions))
  for (const populated of [false, true])
    test(`real ${kind} preserves ${populated ? 'populated' : 'empty'} DB`, async () => {
      const { root, dir, db } = fixture();
      try {
        const r = cliRunner(db);
        await r.exec('PRAGMA user_version=0;');
        if (populated) {
          await applyPending(r, { migrationsDir: dir, appVersion: 'test' });
          await r.exec('INSERT INTO a(id) VALUES(123);');
        }
        const before = await dump(r),
          bytes = fs.readFileSync(db);
        corrupt(dir);
        for (const fn of [applyPending, verifyHead])
          await assert.rejects(() => fn(r, { migrationsDir: dir, appVersion: 'test' }), {
            code: 'ERR_MIGRATION_CORPUS',
          });
        assert.deepEqual(await dump(r), before);
        assert.deepEqual(fs.readFileSync(db), bytes);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

test('sparse [1,3] bootstrap and changed valid corpus preserve ledger conflict', async () => {
  const { root, dir, db } = fixture();
  try {
    fs.unlinkSync(path.join(dir, '0002__b.sql'));
    fs.writeFileSync(
      path.join(dir, 'CHECKSUMS.json'),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(JSON.parse(fs.readFileSync(path.join(dir, 'CHECKSUMS.json'), 'utf8'))).filter(
            ([n]) => n !== '0002__b.sql'
          )
        )
      )
    );
    const r = cliRunner(db);
    assert.deepEqual((await bootstrapFresh(r, { migrationsDir: dir, appVersion: 'test' })).applied, [1, 3]);
    assert.deepEqual(await verifyHead(r, { migrationsDir: dir }), { ok: true });
    fs.appendFileSync(path.join(dir, '0001__a.sql'), '-- changed\n');
    await assert.rejects(() => applyPending(r, { migrationsDir: dir }), { code: 'ERR_MIGRATION_CORPUS' });
    assert.equal((await r.all('SELECT status FROM schema_migrations WHERE version=1'))[0].status, 'applied');
    writeFixture(dir, { '0001__a.sql': sql('a') + '-- changed\n' });
    await assert.rejects(() => applyPending(r, { migrationsDir: dir }), /repair_required/);
    assert.equal(
      (await r.all('SELECT status FROM schema_migrations WHERE version=1'))[0].status,
      'repair_required'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepted content survives replacement; fresh load and forged context refuse', async () => {
  const { root, dir, db } = fixture();
  try {
    const corpus = loadMigrationCorpus(dir);
    fs.appendFileSync(path.join(dir, '0001__a.sql'), '-- bad');
    assert.throws(() => loadMigrationCorpus(dir), { code: 'ERR_MIGRATION_CORPUS' });
    assert.throws(() => resolveCorpus(dir, { ...corpus }), { code: 'ERR_MIGRATION_CORPUS' });
    assert.throws(() => resolveCorpus(root, corpus), { code: 'ERR_MIGRATION_CORPUS' });
    const selected = materializeMigrations(path.join(root, 'selected'), [
      { corpus, name: '0001__a.sql', asName: '0003__renamed.sql' },
    ]);
    assert.equal(selected.migrations[0].checksum, corpus.migrations[0].checksum);
    assert.equal(selected.migrations[0].sql, files['0001__a.sql']);
    await applyPending(cliRunner(db), { migrationsDir: dir, corpus, appVersion: 'test' });
    assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: dir, corpus }), { ok: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deterministic during-read and final-set replacements refuse', () => {
  const { root, dir } = fixture();
  const read = fs.readFileSync,
    list = fs.readdirSync;
  try {
    let count = 0;
    fs.readFileSync = function (...args) {
      const b = read.apply(this, args);
      if (typeof args[0] === 'number' && ++count === 2)
        fs.appendFileSync(path.join(dir, '0001__a.sql'), '-- changed');
      return b;
    };
    assert.throws(() => loadMigrationCorpus(dir), { code: 'ERR_MIGRATION_CORPUS' });
    fs.readFileSync = read;
    writeFixture(dir, files);
    let lists = 0;
    fs.readdirSync = function (...args) {
      if (args[0] === dir && ++lists === 2) fs.writeFileSync(path.join(dir, '0004__d.sql'), sql('d'));
      return list.apply(this, args);
    };
    assert.throws(() => loadMigrationCorpus(dir), { code: 'ERR_MIGRATION_CORPUS' });
  } finally {
    fs.readFileSync = read;
    fs.readdirSync = list;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
