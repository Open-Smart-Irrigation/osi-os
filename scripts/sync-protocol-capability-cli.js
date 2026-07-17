#!/usr/bin/env node
'use strict';
// scripts/sync-protocol-capability-cli.js — the pinned CLI surface for
// osi-sync-protocol-state.
//
// Source of truth: docs/superpowers/plans/2026-07-15-sync-delivery-stop-loss.md,
// Task 3 Step 0 (line 323: "scripts/sync-protocol-capability-cli.js exposes
// only initialize-factory-zero, initialize, status, record-v2-disposition,
// prepare-disposition-restore, invalidate-v2-disposition,
// prepare-database-restore, complete-database-restore-reconciliation,
// prepare-integrity-recovery, complete-integrity-recovery, and
// authorize-reset, and delegates parsing, identity normalization, locking,
// and CAS to that same helper.") and the exact CLI forms at lines 364-500.
//
// This slice implements only `initialize` and `status`. Every other verb
// is pinned in VERB_FLAGS (so its exact flag surface is fixed now and a
// later slice cannot silently redefine it) but returns a bounded
// NOT_IMPLEMENTED_IN_THIS_SLICE error and exits nonzero — see the brief:
// "All other verbs ... must exist in the verb table and exit nonzero with
// a bounded NOT_IMPLEMENTED_IN_THIS_SLICE error."
//
// Unknown/duplicate flags, relative/symlinked path-flag values, extra
// positional arguments, and an unrecognized verb all fail before any work
// starts (plan line 361: "Unknown/duplicate flags, stdin, relative/
// symlinked paths, extra positional arguments, and wrong verb fields
// fail.").

const path = require('node:path');
const protocolState = require(
  path.join(
    __dirname,
    '..',
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state'
  )
);

function cliError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// Flag type -> validator. `path` flags must be absolute and their existing
// components must not be symlinks (enforced by the shared helper's own
// assertNoSymlinkComponents, invoked lazily so we don't require existence
// for "-out"/absent-path flags here).
const FLAG_TYPES = {
  path(value, flag) {
    if (typeof value !== 'string' || !value.startsWith('/')) {
      throw cliError('cli_flag_not_absolute_path', `${flag} must be an absolute path`, { flag, value });
    }
    protocolState.__internal.assertNoSymlinkComponents(value);
    return value;
  },
  pathOrLiteral(literal) {
    return (value, flag) => {
      if (value === literal) return value;
      return FLAG_TYPES.path(value, flag);
    };
  },
  string(value, flag) {
    if (typeof value !== 'string' || value.length === 0) {
      throw cliError('cli_flag_empty', `${flag} must be a non-empty string`, { flag, value });
    }
    return value;
  },
  generation(value, flag) {
    if (!/^(0|[1-9]\d*)$/.test(value)) {
      throw cliError('cli_flag_invalid_generation', `${flag} must be a non-negative integer`, { flag, value });
    }
    return Number.parseInt(value, 10);
  },
  sha256(value, flag) {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw cliError('cli_flag_invalid_sha256', `${flag} must be a lowercase 64-hex-digit sha256`, { flag, value });
    }
    return value;
  },
  sha256OrAbsent(value, flag) {
    if (value === 'absent') return value;
    return FLAG_TYPES.sha256(value, flag);
  },
};

const PATH_FLAGS_COMMON = {
  '--root': 'path',
  '--witness-root': 'path',
  '--activity-witness-root': 'path',
};

const DEPLOYMENT_STATE_FLAGS = {
  '--deployment-state': 'path',
};

// VERB_FLAGS: verb -> { flagName: type, ... }. Every flag is required
// unless listed in `optional`. This is the complete, pinned CLI surface
// from the plan text; verbs beyond initialize/status are intentionally
// unimplemented (see NOT_IMPLEMENTED_VERBS below) but their flag surface
// is fixed here so a later slice cannot casually redefine it.
const VERB_FLAGS = {
  'initialize-factory-zero': {
    ...PATH_FLAGS_COMMON,
    ...DEPLOYMENT_STATE_FLAGS,
    '--expected-baseline-id': 'string',
    '--expected-phase': 'string',
    '--expected-baseline-prefix': 'string',
    '--expected-parent-generation': 'generation',
    '--operation-id': 'string',
    '--factory-provenance': 'path',
    '--image-guard-manifest': 'path',
    '--factory-seed-receipt': 'path',
    '--database': 'path',
    '--ack-audit-report': 'path',
    '--factory-intent-out': 'path',
    '--factory-zero-source-receipt-out': 'path',
  },
  initialize: {
    ...PATH_FLAGS_COMMON,
    ...DEPLOYMENT_STATE_FLAGS,
    '--expected-deployment-id': 'string',
    '--expected-phase': 'string',
    '--expected-parent-generation': 'generation',
    '--operation-id': 'string',
    '--ack-audit-report': 'path',
    '--backup-manifest': 'path',
    '--expected-capability-head-sha256': 'sha256OrAbsent',
    '--expected-witness-head-sha256': 'sha256OrAbsent',
  },
  status: {
    ...PATH_FLAGS_COMMON,
  },
  'record-v2-disposition': {
    ...PATH_FLAGS_COMMON,
    ...DEPLOYMENT_STATE_FLAGS,
    '--expected-deployment-id': 'string',
    '--expected-phase': 'string',
    '--expected-parent-generation': 'generation',
    '--operation-id': 'string',
    '--ack-audit-report': 'path',
    '--backup-manifest': 'path',
    '--disposition-receipt': 'path',
    '--expected-disposition-receipt-sha256': 'sha256',
    '--expected-identity-sha256': 'sha256',
    '--expected-head-sha256': 'sha256',
    '--expected-witness-sha256': 'sha256',
  },
  'prepare-disposition-restore': {
    ...PATH_FLAGS_COMMON,
    ...DEPLOYMENT_STATE_FLAGS,
    '--expected-deployment-id': 'string',
    '--expected-parent-generation': 'generation',
    '--recovery-operation-id': 'string',
    '--expected-recovery-phase': 'string',
    '--ack-audit-report': 'path',
    '--backup-manifest': 'path',
    '--expected-backup-sha256': 'sha256',
    '--expected-identity-sha256': 'sha256',
    '--expected-head-sha256': 'sha256',
    '--expected-witness-sha256': 'sha256',
    '--prepare-intent-out': 'path',
    '--result-out': 'path',
  },
  'invalidate-v2-disposition': {
    ...PATH_FLAGS_COMMON,
    ...DEPLOYMENT_STATE_FLAGS,
    '--expected-deployment-id': 'string',
    '--expected-parent-generation': 'generation',
    '--recovery-operation-id': 'string',
    '--expected-recovery-phase': 'string',
    '--restore-preparation-result': 'path',
    '--restore-receipt': 'path',
    '--ack-audit-report': 'path',
    '--expected-identity-sha256': 'sha256',
    '--expected-head-sha256': 'sha256',
    '--expected-witness-sha256': 'sha256',
  },
  'prepare-database-restore': {
    ...PATH_FLAGS_COMMON,
    ...DEPLOYMENT_STATE_FLAGS,
    '--expected-deployment-id': 'string',
    '--expected-parent-generation': 'generation',
    '--recovery-operation-id': 'string',
    '--expected-recovery-phase': 'string',
    '--backup-manifest': 'path',
    '--restore-baseline': 'path',
    '--reverse-merge-adapter-inventory': 'path',
    '--backup-command-audit-report': 'path',
    '--backup-farming-audit-report': 'path',
    '--current-command-audit-report': 'path',
    '--current-farming-audit-report': 'path',
    '--current-snapshot': 'path',
    '--database-lineage-invalidation-receipt': FLAG_TYPES.pathOrLiteral('not-applicable'),
    '--expected-head-sha256': 'sha256',
    '--expected-witness-sha256': 'sha256',
    '--expected-activity-generation': 'generation',
    '--expected-activity-head-sha256': 'sha256',
    '--prepare-intent-out': 'path',
    '--result-out': 'path',
  },
  'complete-database-restore-reconciliation': {
    ...PATH_FLAGS_COMMON,
    ...DEPLOYMENT_STATE_FLAGS,
    '--expected-deployment-id': 'string',
    '--expected-parent-generation': 'generation',
    '--recovery-operation-id': 'string',
    '--expected-recovery-phase': 'string',
    '--prepare-result': 'path',
    '--merge-receipt': 'path',
    '--reverse-merge-adapter-inventory': 'path',
    '--post-merge-audit-report': 'path',
    '--expected-head-sha256': 'sha256',
    '--expected-witness-sha256': 'sha256',
    '--expected-activity-generation': 'generation',
    '--expected-activity-head-sha256': 'sha256',
  },
  'prepare-integrity-recovery': {
    ...PATH_FLAGS_COMMON,
    ...DEPLOYMENT_STATE_FLAGS,
    '--recovery-request': 'path',
    '--authority': 'path',
    '--backup-manifest': 'path',
    '--database-lineage-invalidation-receipt': FLAG_TYPES.pathOrLiteral('not-applicable'),
    '--forensic-destination': 'path',
    '--result-out': 'path',
  },
  'complete-integrity-recovery': {
    ...PATH_FLAGS_COMMON,
    ...DEPLOYMENT_STATE_FLAGS,
    '--recovery-request': 'path',
    '--reconciliation-authority': 'path',
    '--forensic-inventory': 'path',
    '--cloud-comparison': 'path',
    '--recovered-rows-manifest': FLAG_TYPES.pathOrLiteral('not-applicable'),
    '--offline-import-manifest': FLAG_TYPES.pathOrLiteral('not-applicable'),
    '--accepted-loss-boundary': FLAG_TYPES.pathOrLiteral('not-applicable'),
    '--command-capability-cutoff-proof': FLAG_TYPES.pathOrLiteral('not-applicable'),
    '--historical-revalidation-receipt': 'path',
    '--post-reconcile-command-audit': 'path',
    '--post-reconcile-farming-audit': 'path',
  },
  'authorize-reset': {
    ...PATH_FLAGS_COMMON,
    '--confirmation': 'path',
    '--backup-manifest': 'path',
    '--ack-audit-report': 'path',
  },
};

const NOT_IMPLEMENTED_VERBS = new Set(Object.keys(VERB_FLAGS).filter((v) => v !== 'initialize' && v !== 'status'));

function typeValidator(type) {
  return typeof type === 'function' ? type : FLAG_TYPES[type];
}

// parseVerbArgs: strict parse of `--flag value` pairs against this verb's
// pinned flag set. Rejects unknown flags, duplicate flags, a flag missing
// its value, and any leftover positional argument.
function parseVerbArgs(verb, argv) {
  const flagSpec = VERB_FLAGS[verb];
  if (!flagSpec) {
    throw cliError('cli_unknown_verb', `unknown verb: ${verb}`, { verb });
  }
  const values = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw cliError('cli_unexpected_positional_argument', `unexpected positional argument: ${token}`, { token });
    }
    if (!Object.prototype.hasOwnProperty.call(flagSpec, token)) {
      throw cliError('cli_unknown_flag', `unknown flag for verb "${verb}": ${token}`, { verb, flag: token });
    }
    if (Object.prototype.hasOwnProperty.call(values, token)) {
      throw cliError('cli_duplicate_flag', `duplicate flag: ${token}`, { flag: token });
    }
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith('--')) {
      throw cliError('cli_flag_missing_value', `flag ${token} requires a value`, { flag: token });
    }
    values[token] = typeValidator(flagSpec[token])(raw, token);
    i += 2;
  }
  for (const flag of Object.keys(flagSpec)) {
    if (!Object.prototype.hasOwnProperty.call(values, flag)) {
      throw cliError('cli_flag_missing', `missing required flag: ${flag}`, { flag });
    }
  }
  return values;
}

function rootOptionsFrom(values) {
  return {
    root: values['--root'],
    witnessRoot: values['--witness-root'],
    activityWitnessRoot: values['--activity-witness-root'],
  };
}

function printBoundedResult(result) {
  // "Each success prints one bounded JSON line containing only state
  // SHA256, generation, mode, active identity hash, and operation result."
  process.stdout.write(
    JSON.stringify({
      capabilityGeneration: result.capabilityGeneration != null ? result.capabilityGeneration : null,
      capabilityHeadSha256: result.capabilityHeadSha256 != null ? result.capabilityHeadSha256 : null,
      mode: result.mode != null ? result.mode : null,
      activeIdentitySha256: result.activeIdentitySha256 != null ? result.activeIdentitySha256 : null,
      operationResult: result.operationResult,
    }) + '\n'
  );
}

function runInitialize(values) {
  const opts = rootOptionsFrom(values);
  protocolState.requireDeploymentPhase(values['--deployment-state'], {
    expectedDeploymentId: values['--expected-deployment-id'],
    expectedPhase: values['--expected-phase'],
    expectedParentGeneration: values['--expected-parent-generation'],
  });
  const result = protocolState.initialize(Object.assign({}, opts, { operationId: values['--operation-id'] }));
  const st = protocolState.status(opts);
  printBoundedResult({
    capabilityGeneration: st.capabilityGeneration,
    capabilityHeadSha256: st.capabilityHeadSha256,
    mode: st.mode,
    activeIdentitySha256: st.activeIdentitySha256,
    operationResult: result.created ? (result.resumed ? 'RESUMED' : 'CREATED') : 'ALREADY_INITIALIZED',
  });
}

function runStatus(values) {
  const opts = rootOptionsFrom(values);
  const st = protocolState.status(opts);
  if (!st.initialized) {
    printBoundedResult({
      capabilityGeneration: null,
      capabilityHeadSha256: null,
      mode: null,
      activeIdentitySha256: null,
      operationResult: st.midFlight ? 'MID_FLIGHT' : 'UNINITIALIZED',
    });
    return;
  }
  printBoundedResult({
    capabilityGeneration: st.capabilityGeneration,
    capabilityHeadSha256: st.capabilityHeadSha256,
    mode: st.mode,
    activeIdentitySha256: st.activeIdentitySha256,
    operationResult: st.resumePending ? 'RESUME_PENDING' : 'HEALTHY',
  });
}

function runNotImplemented(verb) {
  throw cliError(
    'NOT_IMPLEMENTED_IN_THIS_SLICE',
    `verb "${verb}" is pinned in the CLI surface but not implemented in this slice`,
    { verb }
  );
}

function run(argv) {
  const verb = argv[0];
  if (!verb) {
    throw cliError('cli_missing_verb', 'usage: sync-protocol-capability-cli.js <verb> [--flag value ...]');
  }
  const rest = argv.slice(1);
  if (NOT_IMPLEMENTED_VERBS.has(verb)) {
    parseVerbArgs(verb, rest);
    runNotImplemented(verb);
    return;
  }
  const values = parseVerbArgs(verb, rest);
  if (verb === 'initialize') {
    runInitialize(values);
    return;
  }
  if (verb === 'status') {
    runStatus(values);
    return;
  }
  throw cliError('cli_unknown_verb', `unknown verb: ${verb}`, { verb });
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[sync-protocol-capability-cli] ${err.code || 'error'}: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { run, parseVerbArgs, VERB_FLAGS, NOT_IMPLEMENTED_VERBS };
