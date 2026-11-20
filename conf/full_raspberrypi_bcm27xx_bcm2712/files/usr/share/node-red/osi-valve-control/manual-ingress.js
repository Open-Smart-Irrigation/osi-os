'use strict';
// Lazy X2 compatibility entry points; the existing loader binding owns the fallback.
module.exports = {
  authenticateValveCommand: function authenticateValveCommand(msg, deps) { return require('../osi-lib').invokeCommandIngress('authenticateValveCommand', msg, deps); },
  checkValveOwnership: function checkValveOwnership(msg, deps) { return require('../osi-lib').invokeCommandIngress('checkValveOwnership', msg, deps); },
  buildValveCommand: function buildValveCommand(msg, deps) { return require('../osi-lib').invokeCommandIngress('buildValveCommand', msg, deps); },
};
