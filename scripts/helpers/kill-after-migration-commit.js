'use strict';

// Preload for scripts/migrate-cli.js in tests (node -r): SIGKILLs the process
// right after the K-th migration's COMMIT returns (KILL_AFTER_COMMIT=K),
// before its postflight and its fingerprint stamp, the worst point of a cut
// during the apply.
const childProcess = require('node:child_process');

const killAfter = Number(process.env.KILL_AFTER_COMMIT || 0);
const real = childProcess.execFileSync;
let commits = 0;
childProcess.execFileSync = function execFileSync(file, args, options) {
  const out = real.apply(this, arguments);
  const input = options && typeof options.input === 'string' ? options.input : '';
  if (file === 'sqlite3' && /INSERT OR REPLACE INTO schema_migrations/.test(input) && /COMMIT;\s*$/.test(input)) {
    commits += 1;
    if (commits === killAfter) process.kill(process.pid, 'SIGKILL');
  }
  return out;
};
