'use strict';

// Preload for scripts/migrate-cli.js in tests (node -r). SIGKILLs the process
// right after the K-th migration's COMMIT returns (KILL_AFTER_COMMIT=K),
// before its postflight and its fingerprint stamp; or right after the K-th
// fingerprint stamp (KILL_AFTER_STAMP=K), before the next migration begins.
const childProcess = require('node:child_process');

const afterCommit = Number(process.env.KILL_AFTER_COMMIT || 0);
const afterStamp = Number(process.env.KILL_AFTER_STAMP || 0);
const real = childProcess.execFileSync;
let commits = 0;
let stamps = 0;
childProcess.execFileSync = function execFileSync(file, args, options) {
  const out = real.apply(this, arguments);
  const input = options && typeof options.input === 'string' ? options.input : '';
  if (file === 'sqlite3' && /COMMIT;\s*$/.test(input)) {
    if (/INSERT OR REPLACE INTO schema_migrations/.test(input) && ++commits === afterCommit) process.kill(process.pid, 'SIGKILL');
    if (/DELETE FROM schema_object_fingerprints/.test(input) && ++stamps === afterStamp) process.kill(process.pid, 'SIGKILL');
  }
  return out;
};
