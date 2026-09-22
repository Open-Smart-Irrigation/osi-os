'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cliRunner } = require('../runner-iface');
const { applyPending } = require('../index');
const { getApplied } = require('../ledger');
const {
  splitTopLevelSqlStatements,
  scanAddColumnStatement,
} = require('../add-column-compat');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-add-column-'));
  const dir = path.join(root, 'migrations');
  fs.mkdirSync(dir);
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return { db: path.join(root, 'farming.db'), dir };
}

test('scanner keeps trigger-body semicolons and semicolons in strings together', () => {
  const statements = splitTopLevelSqlStatements(`
    ALTER TABLE t ADD COLUMN label TEXT DEFAULT 'a;--b';
    CREATE TRIGGER trg AFTER INSERT ON t BEGIN
      INSERT INTO log(value) VALUES ('inside;trigger');
      INSERT INTO log(value) VALUES ('-- still string');
    END;
  `);
  assert.equal(statements.length, 2);
  assert.equal(scanAddColumnStatement(statements[0]).column, 'label');
  assert.match(statements[1], /CREATE TRIGGER/);
});

test('scanner keeps CASE expressions inside a trigger body', () => {
  const statements = splitTopLevelSqlStatements(`
    CREATE TRIGGER trg AFTER INSERT ON t BEGIN
      SELECT CASE WHEN NEW.id = 1 THEN 1 ELSE 2 END;
      INSERT INTO log(value) VALUES ('after case');
    END;
    ALTER TABLE t ADD COLUMN label TEXT;
  `);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /INSERT INTO log/);
  assert.equal(scanAddColumnStatement(statements[1]).column, 'label');
});

test('scanner keeps CASE END inside trigger bodies', () => {
  const statements = splitTopLevelSqlStatements(`
    CREATE TRIGGER trg_case AFTER INSERT ON t BEGIN
      INSERT INTO log(value) VALUES (CASE WHEN NEW.id > 0 THEN 'yes' ELSE 'no' END);
      INSERT INTO log(value) VALUES ('after-case');
    END;
    CREATE TABLE after_trigger(id INTEGER);
  `);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /after-case/);
  assert.match(statements[1], /CREATE TABLE after_trigger/);
});

test('scanner handles comments between trigger keywords and at end of file', () => {
  const statements = splitTopLevelSqlStatements(`
    CREATE /* generated */ TRIGGER trg AFTER INSERT ON t BEGIN
      INSERT INTO log(value) VALUES ('ok');
    END;
    ALTER TABLE t ADD COLUMN label TEXT; -- final comment`);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /INSERT INTO log/);
  assert.equal(scanAddColumnStatement(statements[1]).column, 'label');
});

test('scanner ignores comments and preserves quoted defaults', () => {
  const parsed = scanAddColumnStatement(`
    -- semicolon ; and ALTER TABLE fake ADD COLUMN nope TEXT
    ALTER TABLE "Valve Settings" ADD COLUMN "sync_version" INTEGER DEFAULT ('a;--b') /* ; */;
  `);
  assert.deepEqual(parsed, {
    table: 'Valve Settings',
    column: 'sync_version',
    type: 'integer',
    hasDefault: true,
    defaultValue: "'a;--b'",
    notNull: false,
    primaryKey: false,
    unsupported: false,
  });
});

test('scanner accepts DEFAULT NULL and canonicalizes redundant default parentheses', () => {
  assert.equal(scanAddColumnStatement('ALTER TABLE t ADD COLUMN a TEXT DEFAULT NULL;').defaultValue, 'null');
  assert.equal(scanAddColumnStatement('ALTER TABLE t ADD COLUMN a INTEGER DEFAULT ((0));').defaultValue, '0');
});

test('scanner keeps adjacent statements after a semicolon', () => {
  assert.equal(splitTopLevelSqlStatements('CREATE TABLE a(x);CREATE TABLE b(y);').length, 2);
  const quoted = scanAddColumnStatement('ALTER TABLE `t``x` ADD COLUMN `c``x` TEXT;');
  assert.equal(quoted.table, 't`x');
  assert.equal(quoted.column, 'c`x');
});

test('scanner rejects malformed or ambiguous ADD COLUMN statements', () => {
  assert.throws(
    () => scanAddColumnStatement('ALTER TABLE t ADD COLUMN x TEXT; ALTER TABLE u ADD COLUMN y TEXT;'),
    /ambiguous|malformed/i
  );
  assert.throws(() => splitTopLevelSqlStatements("ALTER TABLE t ADD COLUMN x TEXT DEFAULT 'unterminated;"), /unterminated/i);
  assert.throws(() => scanAddColumnStatement('ALTER TABLE t ADD COLUMN x'), /malformed/i);
});

test('matching preexisting ADD COLUMN is skipped while trigger SQL still executes', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT DEFAULT \'seed\');\nCREATE TABLE log (value TEXT);\n',
    '0002__compat.sql': `-- risk: additive
ALTER TABLE t ADD COLUMN label TEXT DEFAULT 'seed';
CREATE TRIGGER trg_t_ai AFTER INSERT ON t BEGIN
  INSERT INTO log(value) VALUES ('ran;ok');
END;
`,
  });
  const runner = cliRunner(db);
  const result = await applyPending(runner, { migrationsDir: dir, appVersion: 'test' });
  assert.deepEqual(result.applied, [1, 2]);
  assert.deepEqual(await runner.all('SELECT name FROM sqlite_master WHERE type=\'trigger\' AND name=\'trg_t_ai\''), [{ name: 'trg_t_ai' }]);
  await runner.exec("INSERT INTO t(label) VALUES ('new');");
  assert.deepEqual(await runner.all('SELECT value FROM log'), [{ value: 'ran;ok' }]);
});

test('a type-only mismatch refuses and records the migration as failed', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, value INTEGER DEFAULT 0);\n',
    '0002__conflict.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN value TEXT DEFAULT 0;\n',
  });
  const runner = cliRunner(db);
  await assert.rejects(
    () => applyPending(runner, { migrationsDir: dir, appVersion: 'test' }),
    /existing column .*value.*(type|default)|conflict/i
  );
  assert.deepEqual((await getApplied(runner)).map((m) => [m.version, m.status]), [[1, 'applied'], [2, 'failed']]);
});

test('a default-only mismatch preserves quoted literal case and refuses', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT DEFAULT "A");\n',
    '0002__conflict.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN value TEXT DEFAULT "a";\n',
  });
  const runner = cliRunner(db);
  await assert.rejects(
    () => applyPending(runner, { migrationsDir: dir, appVersion: 'test' }),
    /existing column .*value.*conflicts/i
  );
  assert.deepEqual((await getApplied(runner)).map((m) => [m.version, m.status]), [[1, 'applied'], [2, 'failed']]);
});

test('a nullability-only mismatch refuses', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, sync_version INTEGER DEFAULT 0);\n',
    '0002__conflict.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;\n',
  });
  const runner = cliRunner(db);
  await assert.rejects(
    () => applyPending(runner, { migrationsDir: dir, appVersion: 'test' }),
    /existing column .*sync_version.*(metadata|type|NOT NULL|PRIMARY KEY)|conflict/i
  );
  assert.deepEqual((await getApplied(runner)).map((m) => [m.version, m.status]), [[1, 'applied'], [2, 'failed']]);
});

test('equivalent DEFAULT (0) skips successfully', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, value INTEGER DEFAULT (0));\n',
    '0002__compat.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN value INTEGER DEFAULT (0);\n',
  });
  const runner = cliRunner(db);
  assert.deepEqual((await applyPending(runner, { migrationsDir: dir, appVersion: 'test' })).applied, [1, 2]);
});

test('a later SQL failure rolls back work after a compatible skip', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT);\nCREATE TABLE log(value TEXT);\n',
    '0002__fails.sql': "-- risk: additive\nALTER TABLE t ADD COLUMN label TEXT;\nINSERT INTO log(value) VALUES ('must roll back');\nINSERT INTO missing_table(value) VALUES ('fail');\n",
  });
  const runner = cliRunner(db);
  await assert.rejects(() => applyPending(runner, { migrationsDir: dir, appVersion: 'test' }), /missing_table|no such table/i);
  assert.deepEqual(await runner.all('SELECT value FROM log'), []);
  assert.deepEqual((await getApplied(runner)).map((m) => [m.version, m.status]), [[1, 'applied'], [2, 'failed']]);
});

test('unsupported constraints refuse only when a preexisting column would be skipped', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT CHECK(value <> \'\'));\n',
    '0002__conflict.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN value TEXT CHECK(value <> \'\');\n',
  });
  const runner = cliRunner(db);
  await assert.rejects(
    () => applyPending(runner, { migrationsDir: dir, appVersion: 'test' }),
    /unsupported ADD COLUMN constraints/i
  );
  assert.deepEqual((await getApplied(runner)).map((m) => [m.version, m.status]), [[1, 'applied'], [2, 'failed']]);
});
