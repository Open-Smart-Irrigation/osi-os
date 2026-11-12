'use strict';

// The external commands both gateway bases carry: the stock ChirpStack
// Gateway OS 4.10.1 and our images (v0.8.0 to v0.8.2). Read from their root
// file systems and tried with the deploy's exact options on one device of
// each (12 November 2026). The two bases ship different BusyBox 1.36.1
// builds; every command and option below behaved alike on both.
//
// Absent on both: stat, timeout, realpath, python3, pkill. Absent on the
// stock base only: sqlite3 (installed by the first deploy through opkg), and
// parted and resize2fs (the root-filesystem grow step; out of scope here).
// tr has no character classes on either: `tr -d '[:space:]'` deletes the
// letters and keeps the spaces.
const BASE_COMMANDS = [
  // BusyBox applets
  'ash', 'awk', 'basename', 'cat', 'chmod', 'chown', 'cmp', 'cp', 'cut', 'date', 'df', 'dirname', 'du', 'echo',
  'false', 'grep', 'head', 'id', 'kill', 'ln', 'logger', 'ls', 'mkdir', 'mktemp', 'mv', 'printf', 'readlink',
  'rm', 'rmdir', 'sed', 'seq', 'setsid', 'sh', 'sha256sum', 'sleep', 'sync', 'tail', 'tar', 'test', 'touch',
  'tr', 'true', 'uname', 'wc',
  // Programs
  'curl', 'jsonfilter', 'logread', 'node', 'npm', 'opkg', 'ubus', 'uci', 'wget',
];

// On our images; on a stock base only after the first deploy installed it.
const INSTALLED_BY_DEPLOY = ['sqlite3'];

const ABSENT_ON_BOTH = ['stat', 'timeout', 'realpath', 'python3', 'pkill'];

module.exports = { BASE_COMMANDS, INSTALLED_BY_DEPLOY, ABSENT_ON_BOTH };
