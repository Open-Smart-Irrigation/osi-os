'use strict';
// Lazy X2 compatibility entry points; the existing loader binding owns the fallback.
module.exports = {
  routeCommand: function routeCommand(msg, deps) { return require('../osi-lib').invokeCommandIngress('routeCommand', msg, deps); },
};
