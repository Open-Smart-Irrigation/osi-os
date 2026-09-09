'use strict';

const crypto = require('node:crypto');

const DB_BINDING = Object.freeze({ variable: 'osiDb', module: 'osi-db-helper' });
const JOURNAL_BINDING = Object.freeze({ variable: 'osiJournal', module: 'osi-journal' });
const LEDGER_BINDING = Object.freeze({ variable: 'osiCommandLedger', module: 'osi-command-ledger' });
const ZONE_COMMAND_BINDING = Object.freeze({ variable: 'osiZoneCommands', module: 'zone-commands' });
const DEVICE_COMMAND_BINDING = Object.freeze({ variable: 'osiDeviceCommands', module: 'device-commands' });
const SCOPE_BINDING = Object.freeze({ variable: 'scope', module: 'scope' });
const SCOPED_ACCESS_COMMANDS_BINDING = Object.freeze({
  variable: 'osiScopedAccessCommands',
  module: 'scoped-access-commands',
});

// Fail closed on complete reviewed sources. Any function change must be reviewed
// and explicitly re-pinned here before either executable flow audit accepts it.
const TASK9_OSI_LIB_NODE_POLICIES = Object.freeze({
  'journal-api-router-fn': Object.freeze({
    funcSha256: '37750504f6b809837a456060ba18546a8f84ab5792bd988886ab07b5f7fa9e13',
    bindings: Object.freeze([DB_BINDING, JOURNAL_BINDING, SCOPE_BINDING]),
  }),
  'command-dedupe-dispatch': Object.freeze({
    funcSha256: '70a8766e6a01346d248fb1a4244910ab86b1659f3840aed48298dc986af1e0c7',
    bindings: Object.freeze([DB_BINDING, JOURNAL_BINDING, LEDGER_BINDING]),
  }),
  'journal-command-apply-fn': Object.freeze({
    funcSha256: 'b4a36cd22082c8a93aac0f7946c9dcb124cef568402a939983aed12238cded72',
    bindings: Object.freeze([DB_BINDING, JOURNAL_BINDING]),
  }),
  'terra-zone-config-command-apply-fn': Object.freeze({
    // P1 fix (Codex review on PR #191): gates on payload shape
    // (terraConfigurationOperation === true) instead of commandType, so a legacy
    // UPSERT_ZONE_CONFIG payload passes through unhandled instead of throwing.
    funcSha256: '363e3707e9bd9025184b9a08d6c167d2b8ac1bbba9bd58d6b5c670e8b8284f26',
    bindings: Object.freeze([DB_BINDING, ZONE_COMMAND_BINDING]),
  }),
  'scoped-access-command-apply-fn': Object.freeze({
    funcSha256: '98e5bf7a989bf60ba6d9803bc696a1464b75229a9c91757e2d8767a423dc37e9',
    bindings: Object.freeze([DB_BINDING, SCOPED_ACCESS_COMMANDS_BINDING, SCOPE_BINDING]),
  }),
  'zone-command-apply-fn': Object.freeze({
    // Wave 3 zone/weather/calibration sync port (AgroLink 9016d220):
    // applies UPSERT_ZONE/DELETE_ZONE/UPSERT_ZONE_LOCATION only -- gated on
    // commandType, not payload shape, so a legacy Terra UPSERT_ZONE_CONFIG
    // payload (handled upstream by terra-zone-config-command-apply-fn) is
    // never re-processed here.
    funcSha256: 'e83cc198efe384ed14ff0be9ea4e6f3395d3f6f5e74450ca37068db4f5a37772',
    bindings: Object.freeze([DB_BINDING, ZONE_COMMAND_BINDING, SCOPE_BINDING]),
  }),
  'weather-zones-command-apply-fn': Object.freeze({
    // Wave 3 zone/weather/calibration sync port (AgroLink 33eb12b94):
    // applies REPLACE_WEATHER_STATION_ZONES only. osi-device-commands on
    // this port is a thin weather-only module -- it never grew AgroLink's
    // sibling UPSERT_DEVICE/UNCLAIM_DEVICE "protected device aggregate"
    // applier, which is out of scope here.
    funcSha256: 'f5984b17ac00a6535be5777b2fd85c5540959c64ca6e3c3c42f93f8b451f3531',
    bindings: Object.freeze([DB_BINDING, DEVICE_COMMAND_BINDING, SCOPE_BINDING]),
  }),
  'command-ack-queue-rest': Object.freeze({
    funcSha256: '473a5272dfb0c6dbea00143258d91b464fa532e5c96f706ce5aab5381f9dbeff',
    bindings: Object.freeze([DB_BINDING, LEDGER_BINDING]),
  }),
});

function hasExactOsiLibOnly(node) {
  if (!node || !Array.isArray(node.libs) || node.libs.length !== 1) return false;
  const binding = node.libs[0];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const keys = Object.keys(binding).sort();
  return keys.length === 2 && keys[0] === 'module' && keys[1] === 'var' &&
    binding.var === 'osiLib' && binding.module === 'osi-lib';
}

function canonicalBindings(bindings) {
  if (!Array.isArray(bindings)) return null;
  const canonical = [];
  for (const binding of bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
    const keys = Object.keys(binding).sort();
    if (keys.length !== 2 || keys[0] !== 'module' || keys[1] !== 'variable' ||
        typeof binding.variable !== 'string' || typeof binding.module !== 'string') return null;
    canonical.push(binding.variable + '\u0000' + binding.module);
  }
  canonical.sort();
  return canonical;
}

function bindingsMatch(actual, expected) {
  const actualCanonical = canonicalBindings(actual);
  const expectedCanonical = canonicalBindings(expected);
  return actualCanonical !== null && expectedCanonical !== null &&
    actualCanonical.length === expectedCanonical.length &&
    actualCanonical.every((value, index) => value === expectedCanonical[index]);
}

function sha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function auditOsiLibBindings(node, expectedBindings) {
  const errors = [];
  if (!hasExactOsiLibOnly(node)) {
    errors.push('function node must declare exactly { var: osiLib, module: osi-lib }');
  }

  const nodeId = node && typeof node.id === 'string' ? node.id : '';
  const policy = TASK9_OSI_LIB_NODE_POLICIES[nodeId];
  if (!policy) {
    errors.push(`function node ${nodeId || '(missing id)'} has no reviewed osi-lib source policy`);
    return { ok: false, errors };
  }
  if (!bindingsMatch(expectedBindings, policy.bindings)) {
    errors.push(`function node ${nodeId} does not request its exact reviewed helper set`);
  }
  if (!node || typeof node.func !== 'string') {
    errors.push(`function node ${nodeId} has no auditable function source`);
  } else if (sha256(node.func) !== policy.funcSha256) {
    errors.push(`function node ${nodeId} source does not match its reviewed SHA-256`);
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  TASK9_OSI_LIB_NODE_POLICIES,
  auditOsiLibBindings,
  hasExactOsiLibOnly,
};
