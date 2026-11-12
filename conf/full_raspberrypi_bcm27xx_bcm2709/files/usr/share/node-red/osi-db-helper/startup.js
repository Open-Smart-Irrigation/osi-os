'use strict';
// Farm database start-up state (NEW-15). Two copies of the native sqlite3
// addon in one Node-RED process keep separate lock tables for the same file
// and damage it under overlapping writes. This module records which SQLite
// driver the process uses, counts the native addons it has mapped, and runs
// one read-only integrity check before the flows start.
//
// Detection only: nothing here moves, restores, quarantines or deletes a
// file. What a gateway does with an already-damaged file is the owner's
// decision and is not made here. Only a driver failure or a second addon
// refuses farm connections.
//
// One state per process: the seed installs two real copies of this package
// (/srv/node-red/osi-db-helper and node_modules/osi-db-helper), and both must
// report and refuse alike.
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { performance } = require('node:perf_hooks');

const FARM_DB = '/data/db/farming.db';
// quick_check reads every page: about 15 ms for 2 MB, about 240 ms for 300 MB
// from a warm cache, 29 s for 300 MB from a cold one (workstation, 2026-11).
// deploy.sh gives a restarted Node-RED 30 s; this bound keeps 20 s of that.
const CHECK_TIMEOUT_MS = 10000;
const CORE_TABLES = ['users', 'devices', 'irrigation_zones'];
const CHECK_SQL = 'PRAGMA quick_check(1); SELECT \'core_tables=\' || count(*) FROM sqlite_master'
  + " WHERE type='table' AND name IN (" + CORE_TABLES.map((name) => "'" + name + "'").join(',') + ');';
const STATE_KEY = Symbol.for('osi.farming-sqlite.startup');
const ADDON = /\/node_sqlite3\.node(?: \(deleted\))?$/;

// Health states the heartbeat carries, most serious first.
const HEALTH_STATES = {
  driver: 'sqlite_driver_unavailable',
  conflict: 'sqlite_module_conflict',
  damaged: 'database_damaged',
  missing_core_tables: 'database_missing_core_tables',
  missing: 'database_missing',
  unreadable: 'database_unreadable',
  not_checked_timeout: 'database_not_checked',
  not_checked: 'database_not_checked',
};

function classify(result) {
  if (result.error && result.error.code === 'ETIMEDOUT') return { status: 'not_checked_timeout', detail: 'check exceeded ' + CHECK_TIMEOUT_MS + ' ms' };
  if (result.error) return { status: 'not_checked', detail: String(result.error.code || result.error.message || result.error) };
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const lines = stdout ? stdout.split(/\r?\n/).filter((line) => !/^\*\*\* in database /.test(line)) : [];
  if (result.status === 0) {
    if (!lines.length) return { status: 'not_checked', detail: 'no quick_check answer' };
    if (lines[0] !== 'ok') return { status: 'damaged', detail: String(lines[0] || 'no quick_check answer').slice(0, 200) };
    const match = /^core_tables=(\d+)$/.exec(lines[1] || '');
    if (!match) return { status: 'not_checked', detail: 'no core table count' };
    if (Number(match[1]) !== CORE_TABLES.length) return { status: 'missing_core_tables', detail: 'core tables present: ' + match[1] };
    return { status: 'healthy', detail: null };
  }
  // Decided by SQLite's message, never by the exit code: builds differ (the
  // same damaged file gives exit 1 on 3.53.1 and exit 11 on 3.46.1), and the
  // message may come on either stream.
  const message = (stderr + '\n' + stdout).trim();
  if (/malformed|not a database|\((?:11|26)\)/i.test(message)) return { status: 'damaged', detail: message.slice(0, 200) };
  if (/unable to open|permission denied|disk I\/O error|\((?:10|14|23)\)/i.test(message)) return { status: 'unreadable', detail: message.slice(0, 200) };
  return { status: 'not_checked', detail: (message || 'sqlite3 exited ' + result.status).slice(0, 200) };
}

function createStartupState({
  files = fs,
  spawnSync = childProcess.spawnSync,
  monotonicNow = () => performance.now(),
  log = (message) => console.error(message),
  farmPath = FARM_DB,
} = {}) {
  const state = {
    status: 'pending', // healthy | damaged | missing_core_tables | missing | unreadable | not_checked_timeout | not_checked
    detail: null,
    check: 'quick_check',
    check_ms: null,
    timeout_ms: CHECK_TIMEOUT_MS,
    driver_mode: null, // node_red | standalone
    driver_error: null,
    native_addons: null, // distinct node_sqlite3.node files mapped; 0 = none loaded yet
    module_conflict: false,
  };
  const reported = new Set();
  let attempted = false;

  function report(code, message) {
    if (reported.has(code)) return;
    reported.add(code);
    log('[osi-db-startup] ERROR ' + message);
  }

  function countAddons() {
    let text;
    try {
      text = files.readFileSync('/proc/self/maps', 'utf8');
    } catch (error) {
      report('maps', 'native SQLite addons could not be counted: ' + String(error && error.message ? error.message : error));
      return null;
    }
    const identities = new Set();
    for (const line of text.split('\n')) {
      if (!ADDON.test(line)) continue;
      const fields = line.trim().split(/\s+/);
      identities.add(fields[3] + ':' + fields[4]);
    }
    return identities.size;
  }

  // Zero addons is "not yet observable", never a fault: at settings.js time
  // no SQLite module is loaded. Once two are mapped the conflict latches.
  function inspectModules() {
    const count = countAddons();
    state.native_addons = count;
    if (count > 1 && !state.module_conflict) {
      state.module_conflict = true;
      report('conflict', 'found ' + count + ' native SQLite addons in this process; farm database connections refused');
    }
    return count;
  }

  function healthState() {
    if (state.driver_error) return HEALTH_STATES.driver;
    if (state.module_conflict) return HEALTH_STATES.conflict;
    return HEALTH_STATES[state.status] || null;
  }

  function getHealth() {
    if (state.driver_mode === 'node_red') inspectModules();
    return { ...state, health_state: healthState() };
  }

  function recordDriver(mode) {
    state.driver_mode = mode;
    state.driver_error = null;
  }

  function driverFailed(error) {
    // The status answer carries no module path: first line, paths replaced.
    state.driver_error = String(error && error.message ? error.message : error).split('\n')[0]
      .replace(/\/[^\s'"]+/g, '<path>').slice(0, 200);
    report('driver', 'native SQLite driver unavailable: ' + state.driver_error + '; farm database connections refused');
  }

  // Read-only and bounded by a monotonic timer; runs once per process.
  function check(filename = farmPath) {
    if (attempted) return getHealth();
    attempted = true;
    const started = monotonicNow();
    try {
      let present = true;
      try {
        files.statSync(filename);
      } catch (error) {
        present = false;
        Object.assign(state, error && error.code === 'ENOENT'
          ? { status: 'missing', detail: 'file is missing' }
          : { status: 'unreadable', detail: String(error && error.code || error) });
      }
      if (present) {
        Object.assign(state, classify(spawnSync('sqlite3', ['-readonly', filename, CHECK_SQL], {
          encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
        })));
      }
    } catch (error) {
      Object.assign(state, { status: 'not_checked', detail: String(error && error.message ? error.message : error).slice(0, 200) });
    }
    state.check_ms = Math.round(monotonicNow() - started);
    if (state.status !== 'healthy') {
      // Report only: the check opens the file read-only and moves or repairs
      // nothing. A fault points to the operator document.
      const fault = ['damaged', 'missing_core_tables', 'missing', 'unreadable'].includes(state.status);
      report('check', 'farm database start-up check: ' + state.status + (state.detail ? ' (' + state.detail + ')' : '')
        + '; reported only, no file was moved or repaired'
        + (fault ? '; see docs/operations/damaged-farm-database.md (osi-os repository)' : ''));
    }
    return getHealth();
  }

  function refuseIfLatched() {
    if (state.driver_error || state.module_conflict) {
      const error = new Error('farm database refused: ' + healthState());
      error.code = 'OSI_SQLITE_REFUSED';
      throw error;
    }
  }

  // Called before every native farm connection is opened. Inside Node-RED it
  // is the second line behind settings.js: it runs the start-up check if
  // settings.js could not. Standalone processes (tests, tools) skip both.
  function beforeOpen(mode) {
    if (mode === 'node_red') {
      if (!attempted) check();
      inspectModules();
      lastInspected = monotonicNow();
    }
    refuseIfLatched();
  }

  // Called before every operation on a farm handle, also on a handle opened
  // before a second addon appeared: once a refusal is latched, no further
  // statement runs through any handle. The map is read at most once a second.
  let lastInspected = -Infinity;
  function guard(mode) {
    if (mode === 'node_red') {
      const now = monotonicNow();
      if (now - lastInspected >= 1000) {
        lastInspected = now;
        inspectModules();
      }
    }
    refuseIfLatched();
  }

  return { check, beforeOpen, guard, getHealth, recordDriver, driverFailed, inspectModules };
}

if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = createStartupState();
module.exports = globalThis[STATE_KEY];
module.exports.createStartupState = createStartupState;
module.exports.classify = classify;
module.exports.CHECK_TIMEOUT_MS = CHECK_TIMEOUT_MS;
