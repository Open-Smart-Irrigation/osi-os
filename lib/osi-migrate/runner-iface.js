'use strict';
const { execFileSync } = require('node:child_process');

// CLI-backed runner for tests + ops. Async to match the future node-sqlite3 runtime adapter.
// Each call is one fresh `sqlite3` process = one connection. Apply a transactional
// migration as ONE exec(sqlText) so BEGIN/COMMIT and any FK toggle share that connection.
function cliRunner(dbPath) {
  return {
    dbPath,
    async exec(sqlText) {
      // -bail: stop at the first error so a failing statement cannot fall through to COMMIT
      // and commit partial work (verified: without -bail, sqlite3 reaches COMMIT on error).
      execFileSync('sqlite3', ['-bail', dbPath], { input: sqlText, encoding: 'utf8' });
    },
    async all(sql) {
      const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
      return out ? JSON.parse(out) : [];
    },
    async close() {},
  };
}

module.exports = { cliRunner };
