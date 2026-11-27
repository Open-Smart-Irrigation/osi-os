'use strict';
// Probe-only preload for r3-dispatch-blank-device-eui (dispatch inventory
// N1): sets DEVICE_EUI to three spaces after the release-smoke runtime assigns
// it, so the oracle starts as a gateway whose DEVICE_EUI is whitespace only
// (cloud client id "device_   ", and every flow's String(env.get('DEVICE_EUI')
// || 'UNKNOWN').trim() is ""). Spaces, because the broker refuses a client id
// with a tab. Loaded through oracle-blank-eui-node.sh as OSI_ORACLE_NODE;
// never shipped.
const assign = Object.assign;
Object.assign = function (target, ...sources) {
  if (target === process.env && sources.some((s) => s && s.OSI_LIB_BASE && 'DEVICE_EUI' in s)) {
    sources = sources.map((s) => (s && s.OSI_LIB_BASE ? { ...s, DEVICE_EUI: '   ' } : s));
  }
  return assign(target, ...sources);
};
