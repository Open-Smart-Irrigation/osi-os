'use strict';

const model = require('./model');
const evaluate = require('./evaluate');
const occurrences = require('./occurrences');
const observations = require('./observations');
const store = require('./store');
const clock = require('./clock');
const api = require('./api');
const lifecycle = require('./lifecycle');
const worker = require('./worker');
const replication = require('./replication');

// Keep the public surface explicit.  In particular, API mutation is shared by
// local routes and cloud adapters; callers must not write policy/control JSON
// directly beside this module.
const routes = require('./routes');

module.exports = {
  routes,
  ...model,
  ...evaluate,
  ...occurrences,
  ...observations,
  ...clock,
  ...api,
  ...lifecycle,
  ...worker,
  ...replication,
  store,
};
