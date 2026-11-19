'use strict';
// One statement at a time on the flows' shared SQLite connection (F-7).
//
// Keep other database handles serialized. For farming.db, forward the stock
// SQLite node's all/run/exec methods to osi-db-helper's FIFO instead. This
// covers msg.topic, fixed and prepared queries (all), and batch SQL (exec),
// including reads that depend on the connection's last_insert_rowid(). The
// package still owns its native handle's open/close lifecycle; that handle no
// longer executes farm queries. No node types, SQL bindings or wires change.
//
// Node-RED loads this file from <userDir>/nodes. In node-red-node-sqlite 1.1.x
// the configuration owns `db` and `dbname`; the handle exists before
// flows:started and no messages run before this hook. Each redeploy gets a new
// handle. Helper loading is lazy so standalone non-farm SQLite users do not
// open farming.db or select its driver. A failed binding refuses all queries
// on the handle and reports degraded health; it must never leave a writer on
// the second connection.
module.exports = function (RED) {
  const MARK = Symbol.for('osi.flowsDbSerialized');
  const SHARED = Symbol.for('osi.flowsDbShared');

  function report(contextNode, text) {
    RED.log.error('[osi-sqlite-serialize] ' + text);
    try {
      const global = contextNode.context().global;
      const counts = global.get('error_counts') || {};
      counts.total = (Number(counts.total) || 0) + 1;
      counts.last = { at: Date.now(), src: 'osi-sqlite-serialize', message: text.slice(0, 120) };
      global.set('error_counts', counts);
    } catch (e) {
      RED.log.error('[osi-sqlite-serialize] could not count the error: ' + (e && e.message ? e.message : e));
    }
  }

  function shareFarmHandle(db, contextNode) {
    if (db[SHARED]) return;
    let facade;
    try {
      const helper = require('osi-db-helper');
      facade = new helper.Database('/data/db/farming.db');
    } catch (error) {
      const text = 'farming.db helper binding failed: ' + String(error && error.message ? error.message : error);
      report(contextNode, text);
      // Never resume native writes when the helper is unavailable.
      for (const method of ['all', 'run', 'exec']) {
        db[method] = function(...args) {
          const callback = args[args.length - 1];
          if (typeof callback === 'function') process.nextTick(() => callback.call(db, error));
          else report(contextNode, text);
          return db;
        };
      }
      return;
    }
    for (const method of ['all', 'run', 'exec']) {
      db[method] = function(...args) {
        const callback = args[args.length - 1];
        // The facade delivers callback errors. Observe the exec promise too,
        // since sqlite3 callers use callbacks and ignore its returned promise.
        facade[method](...args).catch((error) => {
          if (typeof callback !== 'function') report(contextNode, String(error && error.message ? error.message : error));
        });
        return db;
      };
    }
    db[SHARED] = true;
  }

  function serializeAll() {
    const configs = [];
    const users = new Map();
    RED.nodes.eachNode((n) => {
      if (n.type === 'sqlitedb') configs.push(n.id);
      if (n.type === 'sqlite' && n.mydb && RED.nodes.getNode(n.id)) users.set(n.mydb, n.id);
    });
    for (const id of configs) {
      // A configuration node no running `sqlite` node uses has no handle.
      if (!users.has(id)) continue;
      const config = RED.nodes.getNode(id);
      const contextNode = config || RED.nodes.getNode(users.get(id));
      const db = config && config.db;
      if (!db || typeof db.serialize !== 'function') {
        report(contextNode, 'sqlitedb ' + id + ': no database handle found; the flows\' database connection is not serialized');
        continue;
      }
      if (config.dbname === '/data/db/farming.db' && config.mod !== 'RO') shareFarmHandle(db, contextNode);
      if (db[MARK]) continue;
      try {
        db.serialize();
        db[MARK] = true;
      } catch (e) {
        report(contextNode, 'sqlitedb ' + id + ': serialize() failed: ' + (e && e.message ? e.message : e) + '; the flows\' database connection is not serialized');
      }
    }
  }

  RED.events.on('flows:started', () => {
    try {
      serializeAll();
    } catch (e) {
      // Counted like the failures above, through any running node's context.
      let contextNode = null;
      try { RED.nodes.eachNode((n) => { if (!contextNode) contextNode = RED.nodes.getNode(n.id); }); } catch (_) { /* reported below without a node */ }
      report(contextNode, (e && e.message ? e.message : e) + '; the flows\' database connection may not be serialized');
    }
  });
};
