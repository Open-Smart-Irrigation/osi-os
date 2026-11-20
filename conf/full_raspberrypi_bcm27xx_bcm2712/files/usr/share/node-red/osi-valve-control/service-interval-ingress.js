'use strict';
// Lazy X2 compatibility entry points; the existing loader binding owns the fallback.
module.exports = {
  parseStregaIntervalRequest: function parseStregaIntervalRequest(msg, deps) { return require('../osi-lib').invokeCommandIngress('parseStregaIntervalRequest', msg, deps); },
};
