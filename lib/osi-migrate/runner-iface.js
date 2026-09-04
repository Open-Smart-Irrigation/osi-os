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

// Parse the -json output of a `sqlite3 ... -json` invocation into rows.
//
// Some sqlite3 CLI builds echo a dot-command's plain "<name> <value>"
// confirmation line (e.g. `.limit function_arg 127` under -json) ahead of the
// actual JSON result, even though the -cmd redirection in cliRunner() below
// is meant to swallow it (2026-09-04: GitHub Actions' runner sqlite3 build
// did this and crashed JSON.parse with "'u' is not valid JSON" - 'u' from
// "f-u-nction_arg" - misreported by verify-sqlite-cli-limits.js as a real
// function_arg-limit violation). Kept as a standalone function so it can be
// unit-tested against both output shapes without needing multiple sqlite3
// builds installed.
function parseSqliteJsonOutput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    const lines = trimmed.split('\n');
    const looksLikeDotCommandEcho = lines.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*\s+-?\d+$/.test(lines[0].trim());
    if (looksLikeDotCommandEcho) {
      const rest = lines.slice(1).join('\n').trim();
      try {
        return JSON.parse(rest);
      } catch { /* fall through to the fail-closed error below */ }
    }
    throw new Error(`unrecognized sqlite3 output (expected JSON): ${JSON.stringify(trimmed.slice(0, 200))}`);
  }
}

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
//
// `.limit NAME VALUE` is wrapped in `.output /dev/null` / `.output` (reset to
// stdout) because at least one sqlite3 CLI build prints a confirmation line
// for the SET form (not just the query form) when run under -json, and that
// text is not itself valid JSON - see parseSqliteJsonOutput() above, which is
// a second, defense-in-depth layer for the same failure mode in case a build
// prints its echo somewhere -cmd redirection does not reach.
function cliRunner(dbPath, opts = {}) {
  const limitCmds = Number.isInteger(opts.functionArgLimit)
    ? ['-cmd', '.output /dev/null', '-cmd', `.limit function_arg ${opts.functionArgLimit}`, '-cmd', '.output']
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
        SQLITE_EXEC_OPTIONS);
      return parseSqliteJsonOutput(out);
    },
    async close() {},
  };
}

module.exports = {
  cliRunner,
  parseSqliteJsonOutput,
  SQLITE_EXEC_OPTIONS,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_MAX_BUFFER,
  SQLITE_TIMEOUT_MS,
};
