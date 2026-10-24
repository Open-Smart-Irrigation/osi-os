'use strict';
// A node:sqlite stand-in for the native sqlite3 binding, for harnesses that
// load the real osi-db-helper on a machine without that binding (CI installs
// only the scripts' AJV dependencies, #392). It covers the binding surface
// osi-db-helper uses: new Database(file[, mode], cb), run, all, exec, close.
// Same approach as the adapter in scripts/test-s2120-ingest-concurrency.js.
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const OPEN_READONLY = 1;

// sqlite3 binds booleans as 1/0, Dates as epoch milliseconds and undefined as
// NULL; node:sqlite refuses those types, so convert them the same way.
function bindValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value;
}

function bindArgs(params) {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params.map(bindValue);
  if (typeof params === 'object') {
    const named = {};
    for (const [key, value] of Object.entries(params)) named[key] = bindValue(value);
    return [named];
  }
  return [bindValue(params)];
}

function createSqlite3Adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      let error = null;
      try {
        this.native = new DatabaseSync(filename, { readOnly: mode === OPEN_READONLY });
      } catch (openError) {
        error = openError;
      }
      queueMicrotask(() => callback && callback.call(this, error));
    }

    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = undefined; }
      let rows;
      try { rows = this.native.prepare(sql).all(...bindArgs(params)); } catch (error) { callback.call(this, error); return this; }
      callback.call(this, null, rows);
      return this;
    }

    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = undefined; }
      let result;
      try { result = this.native.prepare(sql).run(...bindArgs(params)); } catch (error) { callback.call(this, error); return this; }
      callback.call({ changes: Number(result.changes), lastID: Number(result.lastInsertRowid) }, null);
      return this;
    }

    exec(sql, callback) {
      try { this.native.exec(sql); } catch (error) { callback.call(this, error); return this; }
      callback.call(this, null);
      return this;
    }

    close(callback) {
      try { this.native.close(); } catch (error) { if (callback) callback.call(this, error); return; }
      if (callback) callback.call(this, null);
    }
  }
  return { Database, OPEN_READONLY, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

let installed = false;

// Loads the native binding where it is installed; falls back to the adapter
// only when `require('sqlite3')` cannot be resolved. Returns nothing.
function installSqlite3Fallback() {
  if (installed) return;
  installed = true;
  const originalLoad = Module._load;
  let adapter = null;
  Module._load = function load(request, parent, isMain) {
    if (request !== 'sqlite3') return originalLoad.call(this, request, parent, isMain);
    try {
      return originalLoad.call(this, request, parent, isMain);
    } catch (error) {
      if (!error || error.code !== 'MODULE_NOT_FOUND') throw error;
      if (!adapter) adapter = createSqlite3Adapter();
      return adapter;
    }
  };
}

module.exports = { createSqlite3Adapter, installSqlite3Fallback };
