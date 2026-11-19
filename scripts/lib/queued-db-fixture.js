'use strict';

// Use the shipped facade and FIFO over a fixture-owned SQLite connection.
// Only the native binding is adapted; transaction and callback semantics come
// from osi-db-helper itself. The test retains ownership of closing its DB.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createSqlite3Adapter } = require('./sqlite3-node-adapter');

const helperPath = path.resolve(__dirname, '../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js');
const facades = new WeakMap();

function facadeDb(native) {
  if (facades.has(native)) return facades.get(native);
  const binding = createSqlite3Adapter();
  const Base = binding.Database;
  binding.Database = class {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') callback = mode;
      this.native = native;
      queueMicrotask(() => callback && callback.call(this, null));
    }
  };
  for (const method of ['all', 'run', 'exec']) {
    binding.Database.prototype[method] = Base.prototype[method];
  }
  binding.Database.prototype.close = function(callback) { if (callback) callback(null); };
  const loaded = new Module(helperPath, module);
  loaded.filename = helperPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(helperPath));
  const requireFromHelper = Module.createRequire(helperPath);
  loaded.require = (name) => name === 'sqlite3' ? binding : requireFromHelper(name);
  loaded._compile(fs.readFileSync(helperPath, 'utf8'), helperPath);
  const facade = new loaded.exports.Database(':memory:');
  facades.set(native, facade);
  return facade;
}

function osiDbFor(native) {
  const facade = facadeDb(native);
  return { Database: function Database() { return facade; } };
}

module.exports = { facadeDb, osiDbFor };
