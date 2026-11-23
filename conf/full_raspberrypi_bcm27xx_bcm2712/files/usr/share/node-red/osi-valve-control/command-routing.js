'use strict';
// Keep the compatibility helper loadable without the optional ingress package.
module.exports = { routeNonValveCommand: function routeNonValveCommand(msg, deps) { return require('../osi-lib').invokeCommandIngress('routeNonValveCommand', msg, deps); } };
