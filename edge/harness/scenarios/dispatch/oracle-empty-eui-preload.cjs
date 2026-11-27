'use strict';
// Probe-only preload for r3-q3-claim-empty-device-eui (fix round Q3): sets
// DEVICE_EUI to the empty string after the release-smoke runtime assigns it,
// so every flow's String(env.get('DEVICE_EUI') || 'UNKNOWN') falls back to
// 'UNKNOWN'. Loaded through oracle-empty-eui-node.sh as OSI_ORACLE_NODE;
// never shipped.
const assign = Object.assign;
Object.assign = function (target, ...sources) {
  if (target === process.env && sources.some((s) => s && s.OSI_LIB_BASE && 'DEVICE_EUI' in s)) {
    sources = sources.map((s) => (s && s.OSI_LIB_BASE ? { ...s, DEVICE_EUI: '' } : s));
  }
  return assign(target, ...sources);
};
