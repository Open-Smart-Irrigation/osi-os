'use strict';
// Probe-only preload for the cb2-nourl-* probes: blanks CHIRPSTACK_API_URL.
// oracle-node-red.js assigns the ChirpStack stand-in's URL directly and then
// runs Object.assign(process.env, standin.env); the URL is blanked right
// after that assign, so the helper's env.get sees '' from then on. Loaded
// through oracle-nourl-node.sh as OSI_ORACLE_NODE; never shipped.
const assign = Object.assign;
Object.assign = function (target, ...sources) {
  const out = assign(target, ...sources);
  if (target === process.env && sources.some((s) => s && 'CHIRPSTACK_PROFILE_STREGA' in s && !('OSI_LIB_BASE' in s))) {
    process.env.CHIRPSTACK_API_URL = '';
  }
  return out;
};
