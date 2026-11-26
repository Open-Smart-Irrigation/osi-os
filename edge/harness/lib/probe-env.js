'use strict';
// The environment a probe scenario was recorded under, for the mutation pass
// (mutate.js applies it to the prefix pass and to both sides of every
// control and mutant). T1 recording takes the same inputs by hand: the
// oracle wrapper through OSI_ORACLE_NODE, the Go side through a wrapper that
// sets or unsets the variable, and --scoped.
//
// Each profile names the oracle's OSI_ORACLE_NODE wrapper
// (scenarios/dispatch/oracle-<name>-node.sh, which preloads a change of one
// variable) and the same change for the Go process (`undefined` unsets the
// variable; Node's spawn drops undefined values).
const path = require('node:path');

const WRAPPERS = path.join(__dirname, '../scenarios/dispatch');
const PROFILES = {
  noapp: { oracle: 'oracle-noapp-node.sh', go: { CHIRPSTACK_APP_ACTUATORS: undefined } },
  nokey: { oracle: 'oracle-nokey-node.sh', go: { CHIRPSTACK_API_KEY: '' } },
  nourl: { oracle: 'oracle-nourl-node.sh', go: { CHIRPSTACK_API_URL: '' } },
  'blank-eui': { oracle: 'oracle-blank-eui-node.sh', go: { DEVICE_EUI: '   ' } },
  'empty-eui': { oracle: 'oracle-empty-eui-node.sh', go: { DEVICE_EUI: '' } },
  fieldtester: { oracle: 'oracle-fieldtester-node.sh', go: { CHIRPSTACK_APP_FIELD_TESTER: 'synthetic-field-tester-app' } },
};

// Scenario name patterns, first match wins. The names carry the profile.
const ENV_BY_NAME = [
  [/noapp/, 'noapp'],
  [/nokey/, 'nokey'],
  [/nourl/, 'nourl'],
  [/blank-device-eui/, 'blank-eui'],
  [/empty-device-eui/, 'empty-eui'],
  [/field-tester/, 'fieldtester'],
];

// Modes: a scenario whose name says "scoped" is recorded with --scoped
// (OSI_SCOPED_ACCESS=1) only. DUAL lists the probes recorded both ways
// ("Record legacy and --scoped" in their descriptions); the inventory pass
// runs them in both modes. Every other probe is legacy.
const DUAL = new Set([
  'r2-ids-user-gate', 'r2-ids-user-spelled', 'r3-q3-auth-rows', 'r3-q3-claim-empty-device-eui', 'r3-q3-claim-gateway-text',
  'r3-q3-daily-nul-valve', 'r3-q3-dispatch-ack-fault', 'r3-q3-skip-bad-clock', 'r3-q3-skip-lower-clock', 'r3-q3-skip-lower-twin-clock',
  'r3-q3-skip-valid-first-clock', 'r4-q4-lost-reason-blob', 'r4-q4-route-blob-tz-linked', 'r4-q4-route-blob-tz',
  'r4-q4-schedule-gw-shapes', 'r4-q4-stored-text-sweep',
  'r5-conn-snapshot-key', 'r5-conn-once-uplinks', 'r5-conn-conflict-order', 'r5-conn-lifecycle-case',
]);

function probeEnv(name) {
  const n = String(name || '');
  const hit = ENV_BY_NAME.find(([re]) => re.test(n));
  const profile = hit ? hit[1] : null;
  const p = profile ? PROFILES[profile] : null;
  const modes = /scoped/.test(n) ? ['scoped'] : DUAL.has(n) ? ['legacy', 'scoped'] : ['legacy'];
  return {
    profile,
    modes,
    // Scoped only: mutate.js runs it scoped without --scoped.
    scoped: modes.length === 1 && modes[0] === 'scoped',
    oracleNode: p ? path.join(WRAPPERS, p.oracle) : null,
    goEnv: p ? { ...p.go } : {},
  };
}

module.exports = { probeEnv, PROFILES, ENV_BY_NAME, DUAL };
