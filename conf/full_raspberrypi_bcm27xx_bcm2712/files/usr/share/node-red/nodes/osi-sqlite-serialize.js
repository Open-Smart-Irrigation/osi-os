'use strict';
// One statement at a time on the flows' shared SQLite connection (F-7).
//
// Every `sqlite` node of the flows uses the one database handle that its
// `sqlitedb` configuration node keeps. node-red-node-sqlite 1.1.x runs that
// handle in sqlite3's parallel mode, so two statements of the flows can be in
// flight on it at once. When one of them waits for the write lock, it sleeps
// in SQLite's busy handler holding the connection's mutex, and the other one's
// finalisation, which sqlite3 runs on the main thread, blocks on that mutex:
// the event loop stops for the whole wait, a helper transaction that needs the
// main thread to reach COMMIT cannot finish, and the waiting write runs out
// its wait and is lost. In serialized mode sqlite3 starts a statement of that
// handle only after the previous one has finished, so this cannot happen.
//
// Node-RED loads this file from <userDir>/nodes (Node-RED 3.1 and 4.0; the
// empty .html beside it is required). It registers no node type and does not
// load sqlite3 itself: it reaches the handle through the configuration node.
//
// It relies on a private property of another package: the `db` property of
// the `sqlitedb` configuration node (node-red-node-sqlite 1.1.0 and 1.1.1).
// The handle is created by the first `sqlite` node's constructor
// (doConnect()), before `flows:started`; a redeploy or a restart of the flows
// creates new configuration nodes with new handles and fires `flows:started`
// again; a reconnect after an open error keeps the same handle. No timer, I/O
// callback or message delivery runs between `flows:starting` and
// `flows:started`, so no statement can reach a handle before it is serialised.
//
// It never stops the flows from starting. If a handle that a `sqlite` node uses
// cannot be found or serialised, it logs one error line and raises the error
// count the heartbeat reports, which puts the health state at `degraded`.
module.exports = function (RED) {
  const MARK = Symbol.for('osi.flowsDbSerialized');

  function report(contextNode, id, reason) {
    const text = 'sqlitedb ' + id + ': ' + reason + '; the flows\' database connection is not serialized';
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
        report(contextNode, id, 'no database handle found');
        continue;
      }
      if (db[MARK]) continue;
      try {
        db.serialize();
        db[MARK] = true;
      } catch (e) {
        report(contextNode, id, 'serialize() failed: ' + (e && e.message ? e.message : e));
      }
    }
  }

  RED.events.on('flows:started', () => {
    try {
      serializeAll();
    } catch (e) {
      RED.log.error('[osi-sqlite-serialize] ' + (e && e.message ? e.message : e) + '; the flows\' database connection may not be serialized');
    }
  });
};
