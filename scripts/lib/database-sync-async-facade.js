'use strict';

function values(params) {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : [params];
}

function createAsyncDatabaseFacade(databaseSync) {
  return Object.freeze({
    async all(sql, params) {
      return databaseSync.prepare(sql).all(...values(params));
    },
    async get(sql, params) {
      return databaseSync.prepare(sql).get(...values(params));
    },
    async run(sql, params) {
      databaseSync.prepare(sql).run(...values(params));
    },
    close() {},
  });
}

module.exports = { createAsyncDatabaseFacade };
