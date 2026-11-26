'use strict';
// Probe-only preload for r4-dispatch-uplink-field-tester: sets
// CHIRPSTACK_APP_FIELD_TESTER to synthetic-field-tester-app when the
// release-smoke runtime assigns its environment (the harness leaves it unset,
// so the uplink field-tester skips never fire otherwise). Loaded through
// oracle-fieldtester-node.sh as OSI_ORACLE_NODE; never shipped.
const assign = Object.assign;
Object.assign = function (target, ...sources) {
  if (target === process.env && sources.some((s) => s && s.OSI_LIB_BASE)) {
    sources = sources.map((s) => (s && s.OSI_LIB_BASE ? { ...s, CHIRPSTACK_APP_FIELD_TESTER: 'synthetic-field-tester-app' } : s));
  }
  return assign(target, ...sources);
};
