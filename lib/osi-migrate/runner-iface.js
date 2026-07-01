'use strict';
const { execFileSync } = require('node:child_process');

const SQLITE_TIMEOUT_MS = 30_000;
const SQLITE_MAX_BUFFER = 64 * 1024 * 1024;
const SQLITE_EXEC_OPTIONS = {
  encoding: 'utf8',
  timeout: SQLITE_TIMEOUT_MS,
  maxBuffer: SQLITE_MAX_BUFFER,
};

// CLI-backed runner for tests + ops. Async to match the future node-sqlite3 runtime adapter.
// Each call is one fresh `sqlite3` process = one connection. Apply a transactional
// migration as ONE exec(sqlText) so BEGIN/COMMIT and any FK toggle share that connection.
function cliRunner(dbPath) {
  return {
    dbPath,
    async exec(sqlText) {
      // -bail: stop at the first error so a failing statement cannot fall through to COMMIT
      // and commit partial work (verified: without -bail, sqlite3 reaches COMMIT on error).
      execFileSync('sqlite3', ['-bail', dbPath], { ...SQLITE_EXEC_OPTIONS, input: sqlText });
    },
    async all(sql) {
      const out = execFileSync('sqlite3', ['-json', dbPath, sql], SQLITE_EXEC_OPTIONS).trim();
      return out ? JSON.parse(out) : [];
    },
    async close() {},
  };
}

module.exports = { cliRunner, SQLITE_EXEC_OPTIONS, SQLITE_MAX_BUFFER, SQLITE_TIMEOUT_MS };
