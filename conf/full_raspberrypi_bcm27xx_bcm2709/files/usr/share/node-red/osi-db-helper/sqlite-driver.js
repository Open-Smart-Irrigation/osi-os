'use strict';
// Selects the native sqlite3 module for farm connections (NEW-15).
//
// Inside Node-RED the helper uses the sqlite3 instance of the
// node-red-node-sqlite package that Node-RED loaded for its SQLite nodes, so
// one SQLite library owns every connection to the farm database. Which copy
// that is depends on the install: the firmware package on a factory image, a
// package in the user directory after `npm install` there. If it cannot be
// found the helper refuses; it never falls back to another copy.
//
// A process that is not Node-RED (a test or a command-line tool) is a separate
// process and uses its own sqlite3, loaded by the helper's own require so that
// tests which intercept that require keep working.
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const startup = require('./startup');

const NODE_RED_FILE = /[\\/](?:@node-red[\\/]runtime[\\/]|node-red[\\/]lib[\\/]red\.js$)/;
const SQLITE_NODE_FILE = /[\\/]node-red-node-sqlite[\\/]sqlite\.js$/;

function selectDriver(loadedFiles, localRequire, requireFrom = (file) => createRequire(file)) {
  if (!loadedFiles.some((file) => NODE_RED_FILE.test(file))) {
    return { mode: 'standalone', sqlite3: localRequire('sqlite3') };
  }
  const nodes = loadedFiles.filter((file) => SQLITE_NODE_FILE.test(file));
  if (nodes.length !== 1) {
    throw new Error(nodes.length
      ? 'more than one node-red-node-sqlite package is loaded'
      : 'Node-RED has not loaded node-red-node-sqlite');
  }
  return { mode: 'node_red', sqlite3: requireFrom(nodes[0])('sqlite3') };
}

// localRequire is the caller's own require, so the module that loads sqlite3
// in standalone mode stays osi-db-helper/index.js.
function refusal() {
  const refused = new Error('farm database refused: sqlite_driver_unavailable');
  refused.code = 'OSI_SQLITE_REFUSED';
  refused.statusCode = 503;
  return refused;
}

function createDriver(localRequire, { loadedFiles = () => Object.keys(require.cache), requireFrom, monotonicNow = () => performance.now() } = {}) {
  let selected = null;
  let lastRuntimeCheck = -Infinity;
  function select() {
    selected = selectDriver(loadedFiles(), localRequire, requireFrom);
    startup.recordDriver(selected.mode);
  }
  // A process that chose its own sqlite3 because it was not Node-RED, and
  // then started Node-RED (an embedding that loads the helper first), must
  // not keep that copy beside the SQLite nodes' one. Checked at most once a
  // second; once seen, the refusal stays until the process restarts.
  function standaloneStillValid() {
    if (selected.mode !== 'standalone') return;
    const now = monotonicNow();
    if (now - lastRuntimeCheck < 1000) return;
    lastRuntimeCheck = now;
    if (loadedFiles().some((file) => NODE_RED_FILE.test(file))) {
      startup.driverFailed(new Error('osi-db-helper chose its own sqlite3 before Node-RED started in this process'));
      throw refusal();
    }
  }
  // Select when the helper loads, as it loaded sqlite3 before (tests replace
  // the loader only while they require the helper). If Node-RED has not loaded
  // its SQLite node yet, the first connection selects again under the same rule.
  try {
    select();
  } catch (error) {
    selected = null;
  }
  function acquire() {
    if (!selected) {
      try {
        select();
      } catch (error) {
        startup.driverFailed(error);
        throw refusal();
      }
    }
    standaloneStillValid();
    startup.beforeOpen(selected.mode);
    return selected.sqlite3;
  }
  // Before each operation on an already open handle. Without a selected
  // driver no native handle of this helper is open (a test factory's handle
  // is not one), so there is nothing to guard.
  acquire.guard = function guard() {
    if (!selected) return;
    standaloneStillValid();
    startup.guard();
  };
  return acquire;
}

module.exports = { createDriver, selectDriver };
