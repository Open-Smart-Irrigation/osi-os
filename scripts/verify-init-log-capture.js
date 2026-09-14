#!/usr/bin/env node
'use strict';

// osi-os#223. Two separate guarantees about Node-RED's output on a gateway,
// one function each:
//
//   scanInit           -- procd forwards the process's stdout and stderr into
//                         syslog, so node.error/node.warn survive the process.
//                         Without it a boot-node failure leaves no trace.
//   scanPersistentSink -- syslog itself is logd, a RAM ring buffer emptied by
//                         a power cycle, so the init also points ubox's log
//                         service at a size-bounded file on /data. Without it
//                         the trace survives a service restart but not a
//                         reboot, which is the case that mattered on Uganda.
//
// Both read the shipped init verbatim. deploy.sh installs this file on every
// deploy (scripts/deploy-fetch-list.test.js pins that), so already-flashed
// gateways take the change without an image rebuild.

const fs = require('node:fs');
const path = require('node:path');

const INIT_REL = 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init';
const INIT_PATH = path.resolve(__dirname, '..', INIT_REL);

// OpenWrt's generated /etc/config/system carries log_size='128'
// (openwrt/package/base-files/files/bin/config_generate), so 128 KiB is the
// ring a stock gateway is running and nothing here may pin below it.
const MIN_LOGD_BUFFER_KIB = 128;

// Drops `<<'TAG' … TAG` heredoc bodies so a brace or a `}` at column 0 inside
// the embedded Node script cannot be read as shell structure.
function stripHeredocs(text) {
  const out = [];
  let terminator = null;
  for (const line of String(text).split('\n')) {
    if (terminator === null) {
      const open = line.match(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*$/);
      if (open) terminator = open[1];
      out.push(line);
    } else if (line.trim() === terminator) {
      terminator = null;
    }
  }
  return out.join('\n');
}

// The body of start_service(), from its opening line to the first `}` at
// column 0. A call anywhere else in the file starts nothing.
function startServiceBlock(text) {
  const lines = stripHeredocs(text).split('\n');
  const start = lines.findIndex((line) => /^start_service\s*\(\)\s*\{\s*$/.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\}\s*$/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// The procd instance block. Params outside it configure nothing.
function instanceBlock(text) {
  const open = String(text).indexOf('procd_open_instance');
  if (open === -1) return null;
  const close = String(text).indexOf('procd_close_instance', open);
  if (close === -1) return null;
  return String(text).slice(open, close);
}

function scanInit(text) {
  const problems = [];
  const block = instanceBlock(text);
  if (block === null) {
    problems.push('no procd_open_instance ... procd_close_instance block found');
    return problems;
  }
  for (const stream of ['stdout', 'stderr']) {
    const declared = new RegExp(`^\\s*procd_set_param\\s+${stream}\\s+1\\s*$`, 'm');
    if (!declared.test(block)) {
      problems.push(
        `the procd instance does not declare "procd_set_param ${stream} 1": `
        + `Node-RED's ${stream} is discarded instead of reaching syslog (osi-os#223)`,
      );
    }
  }
  return problems;
}

function scanPersistentSink(text) {
  const problems = [];
  const source = String(text);

  if (!/ensure_persistent_syslog_sink\s*\(\)/.test(source)) {
    problems.push(
      'no ensure_persistent_syslog_sink() definition: syslog is a RAM ring buffer, '
      + 'so stdout/stderr capture alone is lost on reboot (osi-os#223)',
    );
  }
  const startBody = startServiceBlock(source);
  if (startBody === null) {
    problems.push('no start_service() definition found, so nothing can call the sink setup');
  } else if (!/^\s*ensure_persistent_syslog_sink\s*$/m.test(startBody)) {
    problems.push('ensure_persistent_syslog_sink is defined but never called from start_service');
  }
  if (!/uci -q set system\.@system\[0\]\.log_file=/.test(source)) {
    problems.push('the sink must be configured through system.@system[0].log_file, the log service\'s own setting');
  }
  if (!/uci -q set system\.@system\[0\]\.log_size=/.test(source)) {
    problems.push(
      'the sink must set system.@system[0].log_size: without a size cap logread writes an '
      + 'unbounded file and fills /data',
    );
  }
  const pin = source.match(/uci -q set system\.@system\[0\]\.log_buffer_size="([^"]*)"/);
  if (!pin) {
    problems.push(
      'the sink must pin system.@system[0].log_buffer_size: log.init derives logd\'s RAM ring '
      + 'from log_size when it is 0, which would restart logd and drop the buffered lines',
    );
  } else if (!/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(pin[1])) {
    problems.push(
      `log_buffer_size is pinned to the literal "${pin[1]}": it must be a variable read back from `
      + 'the live config, so the pin matches the ring this gateway is already running',
    );
  } else if (!/uci -q get system\.@system\[0\]\.log_buffer_size/.test(source)
      || !/uci -q get system\.@system\[0\]\.log_size/.test(source)) {
    problems.push(
      'the log_buffer_size pin must be derived from both live values (log_buffer_size, then '
      + 'log_size), the way log.init derives the ring itself',
    );
  }
  const floorMatch = source.match(/OSI_LOGD_MIN_BUFFER_KIB="(\d+)"/);
  if (!floorMatch) {
    problems.push('OSI_LOGD_MIN_BUFFER_KIB is not declared as a plain integer of KiB');
  } else if (Number(floorMatch[1]) < MIN_LOGD_BUFFER_KIB) {
    problems.push(
      `OSI_LOGD_MIN_BUFFER_KIB=${floorMatch[1]} is below ${MIN_LOGD_BUFFER_KIB}: OpenWrt's `
      + 'generated /etc/config/system ships log_size=128, so a smaller pin shrinks the ring a '
      + 'stock gateway is running and restarts logd',
    );
  } else if (!new RegExp(`-lt\\s+"\\$OSI_LOGD_MIN_BUFFER_KIB"`).test(source)) {
    problems.push('OSI_LOGD_MIN_BUFFER_KIB is declared but never enforced as a floor on the pin');
  }
  const sizeMatch = source.match(/OSI_PERSISTENT_LOG_SIZE_KIB="(\d+)"/);
  if (!sizeMatch) {
    problems.push('OSI_PERSISTENT_LOG_SIZE_KIB is not declared as a plain integer of KiB');
  } else if (Number(sizeMatch[1]) <= 0 || Number(sizeMatch[1]) > 8192) {
    problems.push(
      `OSI_PERSISTENT_LOG_SIZE_KIB=${sizeMatch[1]} is outside 1..8192 KiB: the worst case on `
      + 'disk is twice this value and /data is shared with farming.db and its backups',
    );
  }
  const fileMatch = source.match(/OSI_PERSISTENT_LOG_FILE="([^"]+)"/);
  if (!fileMatch) {
    problems.push('OSI_PERSISTENT_LOG_FILE is not declared');
  } else if (!fileMatch[1].startsWith('/data/')) {
    problems.push(
      `OSI_PERSISTENT_LOG_FILE=${fileMatch[1]} is not under /data: a sink on the RAM-backed or `
      + 'read-only parts of the filesystem does not survive a reboot',
    );
  }
  return problems;
}

function run() {
  const text = fs.readFileSync(INIT_PATH, 'utf8');
  const problems = [...scanInit(text), ...scanPersistentSink(text)];
  if (problems.length) {
    console.error('verify-init-log-capture: FAIL');
    for (const problem of problems) console.error(`  ${INIT_REL}: ${problem}`);
    process.exit(1);
  }
  console.log('verify-init-log-capture: OK (1 init script)');
}

module.exports = { scanInit, scanPersistentSink, run, INIT_PATH, INIT_REL };

if (require.main === module) run();
