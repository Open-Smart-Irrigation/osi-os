'use strict';
// Lazy X2 compatibility entry points; the existing loader binding owns the fallback.
module.exports = {
  formatStregaResponse: function formatStregaResponse(msg, deps) { return require('../osi-lib').invokeCommandIngress('formatStregaResponse', msg, deps); },
  buildActuatorLog: function buildActuatorLog(msg, deps) { return require('../osi-lib').invokeCommandIngress('buildActuatorLog', msg, deps); },
};
