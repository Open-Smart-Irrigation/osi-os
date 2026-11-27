'use strict';
// Probe-only preload for the cb2-nokey-* probes (dispatch inventory valve-cancel
// client-construction and the client-construction sweep): blanks
// CHIRPSTACK_API_KEY after the release-smoke runtime assigns it, so the
// Node-RED oracle runs as a gateway whose .chirpstack.env is not written yet.
// Loaded through oracle-nokey-node.sh as OSI_ORACLE_NODE; never shipped.
const assign = Object.assign;
Object.assign = function (target, ...sources) {
  if (target === process.env && sources.some((s) => s && s.OSI_LIB_BASE && 'CHIRPSTACK_API_KEY' in s)) {
    sources = sources.map((s) => (s && s.OSI_LIB_BASE ? { ...s, CHIRPSTACK_API_KEY: '' } : s));
  }
  return assign(target, ...sources);
};
