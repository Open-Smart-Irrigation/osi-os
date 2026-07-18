#!/usr/bin/env node
'use strict';

// A0 deliberately ships only the closed argv boundary for database backup
// and restore integration. The sync-protocol slice owns the typed linked
// recovery/preparation validators that can grant mutation authority. Until
// those validators are resident and manifest-bound, every recognized branch
// stops before opening any database path.

const path = require('node:path');

class DeferredDatabaseOperation extends Error {
  constructor(purpose) {
    super(`NOT_IMPLEMENTED_IN_THIS_SLICE: ${purpose} requires the typed sync-protocol preparation validator`);
    this.code = 'NOT_IMPLEMENTED_IN_THIS_SLICE';
  }
}

const SPECS = Object.freeze({
  snapshot: Object.freeze({
    'command-ledger-disposition': Object.freeze([
      'source', 'destination', 'manifest-out', 'state', 'expected-operation-id',
      'expected-state-sha256', 'preparation',
    ]),
    'general-database-restore': Object.freeze([
      'source', 'destination', 'manifest-out', 'state', 'expected-operation-id',
      'expected-state-sha256', 'preparation',
    ]),
    'database-integrity-recovery': Object.freeze([
      'source', 'destination', 'manifest-out', 'state', 'expected-operation-id',
      'expected-state-sha256', 'preparation',
    ]),
  }),
  restore: Object.freeze({
    'command-ledger-disposition': Object.freeze([
      'state', 'recovery-operation-id', 'backup-manifest', 'expected-path',
      'expected-size', 'expected-sha256', 'restore-preparation-result',
    ]),
    'general-database-restore': Object.freeze([
      'state', 'recovery-operation-id', 'backup-manifest', 'restore-baseline',
      'expected-path', 'expected-size', 'expected-sha256',
      'database-restore-preparation-result',
    ]),
    'database-integrity-recovery': Object.freeze([
      'state', 'request', 'authority', 'preparation-result', 'backup-manifest',
      'forensic-destination',
    ]),
  }),
});

const PATH_FLAGS = new Set([
  'source', 'destination', 'manifest-out', 'state', 'backup-manifest',
  'expected-path', 'restore-preparation-result', 'restore-baseline',
  'database-restore-preparation-result', 'request', 'authority',
  'preparation-result', 'forensic-destination',
]);

function parse(argv) {
  const [verb, ...rest] = argv;
  if (!Object.hasOwn(SPECS, verb)) throw new Error('expected snapshot or restore verb');
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag || !flag.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('invalid argv');
    const key = flag.slice(2);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate flag ${flag}`);
    values[key] = value;
  }
  const purpose = values.purpose;
  if (!purpose || !Object.hasOwn(SPECS[verb], purpose)) throw new Error('unknown database operation purpose');
  const required = SPECS[verb][purpose];
  const allowed = new Set(['purpose', ...required]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
  for (const key of required) if (!values[key]) throw new Error(`missing --${key}`);
  for (const key of required) {
    if (PATH_FLAGS.has(key) && !path.isAbsolute(values[key])) throw new Error(`--${key} must be absolute`);
  }
  if (values['expected-sha256'] && !/^[0-9a-f]{64}$/.test(values['expected-sha256'])) {
    throw new Error('--expected-sha256 must be lowercase sha256');
  }
  if (values['expected-state-sha256'] && !/^[0-9a-f]{64}$/.test(values['expected-state-sha256'])) {
    throw new Error('--expected-state-sha256 must be lowercase sha256');
  }
  if (values['expected-size'] && !/^(0|[1-9][0-9]*)$/.test(values['expected-size'])) {
    throw new Error('--expected-size must be a nonnegative integer');
  }
  return { verb, purpose, values };
}

function dispatch(argv) {
  const parsed = parse(argv);
  throw new DeferredDatabaseOperation(`${parsed.verb}:${parsed.purpose}`);
}

if (require.main === module) {
  try {
    dispatch(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'INVALID_ARGUMENT', error: error.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { SPECS, DeferredDatabaseOperation, parse, dispatch };
