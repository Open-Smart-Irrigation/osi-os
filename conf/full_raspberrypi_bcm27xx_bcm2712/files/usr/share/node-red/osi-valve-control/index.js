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

// X2 compatibility calls are lazy: an absent optional ingress package must not
// disable any existing transport, cancellation or worker export.
const ingressFiles = {
  routeCommand: './command-ingress',
  authenticateValveCommand: './manual-ingress',
  checkValveOwnership: './manual-ingress',
  buildValveCommand: './manual-ingress',
  cancelValveRequest: './cancel-ingress',
  parseStregaIntervalRequest: './service-interval-ingress',
  parseStregaModelRequest: './service-model-ingress',
  parseStregaTimedRequest: './service-timed-ingress',
  parseStregaMagnetRequest: './service-magnet-ingress',
  parseStregaPartialRequest: './service-partial-ingress',
  parseStregaFlushRequest: './service-flush-ingress',
  formatStregaResponse: './run-log-adapters',
  buildActuatorLog: './run-log-adapters',
};
for (const [entry, file] of Object.entries(ingressFiles)) {
  module.exports[entry] = (...args) => require(file)[entry](...args);
}
