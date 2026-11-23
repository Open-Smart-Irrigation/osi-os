'use strict';
// Lazy X2 compatibility entry points; the existing loader binding owns the fallback.
module.exports = {
  parseStregaPartialRequest: function parseStregaPartialRequest(msg, deps) { return require('../osi-lib').invokeCommandIngress('parseStregaPartialRequest', msg, deps); },
};
