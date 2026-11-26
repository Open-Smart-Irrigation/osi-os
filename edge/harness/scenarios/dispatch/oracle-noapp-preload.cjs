'use strict';
// Probe-only preload for rd-noapp-manual (dispatch inventory row B4): blanks
// CHIRPSTACK_APP_ACTUATORS after the release-smoke runtime assigns it, so the
// Node-RED oracle runs as an unprovisioned gateway does. Loaded through
// oracle-noapp-node.sh as OSI_ORACLE_NODE; never shipped.
const assign = Object.assign;
Object.assign = function (target, ...sources) {
  if (target === process.env && sources.some((s) => s && s.OSI_LIB_BASE && 'CHIRPSTACK_APP_ACTUATORS' in s)) {
    sources = sources.map((s) => (s && s.OSI_LIB_BASE ? { ...s, CHIRPSTACK_APP_ACTUATORS: '' } : s));
  }
  return assign(target, ...sources);
};
