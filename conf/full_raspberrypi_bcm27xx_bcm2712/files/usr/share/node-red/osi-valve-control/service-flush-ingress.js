'use strict';
// Lazy X2 compatibility entry points; the existing loader binding owns the fallback.
module.exports = {
  parseStregaFlushRequest: function parseStregaFlushRequest(msg, deps) { return require('../osi-lib').invokeCommandIngress('parseStregaFlushRequest', msg, deps); },
};
