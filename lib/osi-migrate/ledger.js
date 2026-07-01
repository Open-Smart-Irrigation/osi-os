'use strict';

function sqlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function ensureLedger(runner) {
  await runner.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TEXT,
      finished_at TEXT,
      status      TEXT NOT NULL,
      error       TEXT,
      app_version TEXT,
      backup_path TEXT
    );
    CREATE TABLE IF NOT EXISTS schema_object_fingerprints (
      object_type TEXT NOT NULL,
      object_name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      PRIMARY KEY (object_type, object_name)
    );`);
}

async function getApplied(runner) {
  return runner.all('SELECT version, name, checksum, status FROM schema_migrations ORDER BY version');
}

function successInsertSql({ version, name, checksum, appVersion, backupPath }) {
  const now = new Date().toISOString();
  return `INSERT OR REPLACE INTO schema_migrations
       (version, name, checksum, applied_at, finished_at, status, error, app_version, backup_path)
     VALUES (${version}, ${sqlQuote(name)}, ${sqlQuote(checksum)}, ${sqlQuote(now)}, ${sqlQuote(now)},
             'applied', NULL, ${sqlQuote(appVersion || '')}, ${sqlQuote(backupPath || '')});`;
}

async function recordSuccess(runner, opts) {
  await runner.exec(successInsertSql(opts));
}

async function recordFailure(runner, { version, name, checksum, appVersion, backupPath, error }) {
  const now = new Date().toISOString();
  await runner.exec(
    `INSERT OR REPLACE INTO schema_migrations
       (version, name, checksum, applied_at, finished_at, status, error, app_version, backup_path)
     VALUES (${version}, ${sqlQuote(name)}, ${sqlQuote(checksum)}, NULL, ${sqlQuote(now)},
             'failed', ${sqlQuote(error || '')}, ${sqlQuote(appVersion || '')}, ${sqlQuote(backupPath || '')});`);
}

async function markRepairRequired(runner, { version, error }) {
  const now = new Date().toISOString();
  await runner.exec(
    `UPDATE schema_migrations
        SET status='repair_required', error=${sqlQuote(error || '')}, finished_at=${sqlQuote(now)}
      WHERE version=${version};`);
}

module.exports = { ensureLedger, getApplied, recordSuccess, recordFailure, markRepairRequired, successInsertSql, sqlQuote };
