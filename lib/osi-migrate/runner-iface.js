'use strict';
const { execFileSync } = require('node:child_process');

const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const SQLITE_TIMEOUT_MS = 120_000; // process timeout must exceed the busy timeout
const SQLITE_MAX_BUFFER = 64 * 1024 * 1024;
const SQLITE_EXEC_OPTIONS = {
  encoding: 'utf8',
  timeout: SQLITE_TIMEOUT_MS,
  maxBuffer: SQLITE_MAX_BUFFER,
};

// CLI-backed runner for tests + ops. Async to match the future node-sqlite3 runtime adapter.
// Each call is one fresh `sqlite3` process = one connection. Apply a transactional
// migration as ONE exec(sqlText) so BEGIN/COMMIT and any FK toggle share that connection.
//
// opts.functionArgLimit (optional) lowers SQLITE_LIMIT_FUNCTION_ARG on every
// connection via the CLI's `.limit` dot-command. Developer and CI sqlite3 builds
// raise SQLITE_MAX_FUNCTION_ARG well above the 127 the OpenWrt gateway build
// enforces, so a statement that parses here can still be rejected on-device
// ("too many arguments on function json_object" - the 0046 live-deploy failure).
// scripts/verify-sqlite-cli-limits.js uses this to replay under the device limit.
function cliRunner(dbPath, opts = {}) {
  const limitCmds = Number.isInteger(opts.functionArgLimit)
    ? ['-cmd', `.limit function_arg ${opts.functionArgLimit}`]
    : [];
  return {
    dbPath,
    async exec(sqlText) {
      // -bail: stop at the first error so a failing statement cannot fall through to COMMIT
      // and commit partial work (verified: without -bail, sqlite3 reaches COMMIT on error).
      execFileSync('sqlite3',
        ['-bail', '-cmd', `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, ...limitCmds, dbPath],
        { ...SQLITE_EXEC_OPTIONS, input: sqlText });
    },
    async all(sql) {
      const out = execFileSync('sqlite3',
        ['-json', '-cmd', `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, ...limitCmds, dbPath, sql],
        SQLITE_EXEC_OPTIONS).trim();
      return out ? JSON.parse(out) : [];
    },
    async close() {},
  };
}

module.exports = { cliRunner, SQLITE_EXEC_OPTIONS, SQLITE_BUSY_TIMEOUT_MS, SQLITE_MAX_BUFFER, SQLITE_TIMEOUT_MS };
