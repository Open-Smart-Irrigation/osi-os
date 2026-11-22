'use strict';
// Lazy X2 compatibility entry points; the existing loader binding owns the fallback.
module.exports = {
  cancelValveRequest: function cancelValveRequest(msg, deps) { return require('../osi-lib').invokeCommandIngress('cancelValveRequest', msg, deps); },
};
