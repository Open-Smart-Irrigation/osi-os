'use strict';
const plan = require('./plan');
const ack = require('./ack');
const store = require('./store');
const push = require('./push');
const api = require('./api');
const workers = require('./workers');
const cloudCommands = require('./cloud-commands');
const cancel = require('./cancel');
const unclaim = require('./unclaim');
const runtime = require('./runtime');
const dispatch = require('./dispatch');
const live = require('./live-wrappers');
const claim = require('./claim');
module.exports = { ...plan, ...ack, ...api, ...workers, ...cloudCommands, ...cancel, ...unclaim, ...runtime, ...dispatch, ...live, store, push, dispatch, claim };

// X2 request/response adapters; transport and worker APIs above stay unchanged.
Object.assign(module.exports,
  require('./command-ingress'),
  require('./manual-ingress'),
  require('./cancel-ingress'),
  require('./service-interval-ingress'),
  require('./service-model-ingress'),
  require('./service-timed-ingress'),
  require('./service-magnet-ingress'),
  require('./service-partial-ingress'),
  require('./service-flush-ingress'),
  require('./run-log-adapters')
);
