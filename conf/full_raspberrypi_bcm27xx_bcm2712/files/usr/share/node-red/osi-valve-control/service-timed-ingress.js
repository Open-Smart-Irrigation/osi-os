'use strict';
// Lazy X2 compatibility entry points; the existing loader binding owns the fallback.
module.exports = {
  parseStregaTimedRequest: function parseStregaTimedRequest(msg, deps) { return require('../osi-lib').invokeCommandIngress('parseStregaTimedRequest', msg, deps); },
};
