'use strict';

const crypto = require('node:crypto');

const DB_BINDING = Object.freeze({ variable: 'osiDb', module: 'osi-db-helper' });
const JOURNAL_BINDING = Object.freeze({ variable: 'osiJournal', module: 'osi-journal' });
const LEDGER_BINDING = Object.freeze({ variable: 'osiCommandLedger', module: 'osi-command-ledger' });

// Fail closed on complete reviewed sources. Any function change must be reviewed
// and explicitly re-pinned here before either executable flow audit accepts it.
const TASK9_OSI_LIB_NODE_POLICIES = Object.freeze({
  'journal-api-router-fn': Object.freeze({
    funcSha256: 'fc2b8358de0bacd30d409baf4be3f281ad01008808039697a2b7a4cc9b7812e3',
    bindings: Object.freeze([DB_BINDING, JOURNAL_BINDING]),
  }),
  'command-dedupe-dispatch': Object.freeze({
    funcSha256: '79a5bcd2aef059def9ebd866bfb9b76ed4d6b25fae5cb5e4cec69aa46e7092f8',
    bindings: Object.freeze([DB_BINDING, JOURNAL_BINDING, LEDGER_BINDING]),
  }),
  'journal-command-apply-fn': Object.freeze({
    funcSha256: '8599d67ae31c8bfe1c7649384f35e60f888b8336e506c7b33f0326041f19e304',
    bindings: Object.freeze([DB_BINDING, JOURNAL_BINDING]),
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
