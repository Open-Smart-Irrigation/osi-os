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
// Every verb below delegates chain parsing, locking, CAS, and receipt
// publication to osi-sync-protocol-state. This executable is only the strict
// argv/file/deployment-authority adapter; importing it performs no dispatch.
//
// Unknown/duplicate flags, relative/symlinked path-flag values, extra
// positional arguments, and an unrecognized verb all fail before any work
// starts (plan line 361: "Unknown/duplicate flags, stdin, relative/
// symlinked paths, extra positional arguments, and wrong verb fields
// fail.").

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const protocolState = require(
  path.join(
    __dirname,
    '..',
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state'
  )
);
const capabilityTransitions = require(
  path.join(
    __dirname,
    '..',
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sync-protocol-state/capability-transitions.js'
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
// from the plan text. The fixed table prevents a dispatcher from accepting
// mode-specific extras or silently redefining a verb.
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

function readJsonFile(filePath, { artifactOwned = false } = {}) {
  protocolState.__internal.assertNoSymlinkComponents(filePath);
  const stat = fs.lstatSync(filePath);
  const mode = stat.mode & 0o777;
  const allowedModes = artifactOwned ? new Set([0o600, 0o644]) : new Set([0o600]);
  if (!stat.isFile() || stat.isSymbolicLink() || !allowedModes.has(mode)) {
    throw cliError('cli_input_file_unsafe', `JSON input must be a regular nonsymlink file with an allowed mode: ${filePath}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw cliError('cli_input_file_wrong_owner', `JSON input is not owned by the invoking service identity: ${filePath}`);
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    throw cliError('cli_input_file_malformed', `JSON input is malformed: ${filePath}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw cliError('cli_input_file_invalid', `JSON input must contain an object: ${filePath}`);
  }
  return value;
}

function readOptionalJson(value, options) {
  return value === 'not-applicable' ? null : readJsonFile(value, options);
}

function canonicalSha256(value) {
  return protocolState.canonicalSha256(value);
}

function requireHash(value, expected, label) {
  const actual = canonicalSha256(value);
  if (actual !== expected) {
    throw cliError('cli_input_hash_mismatch', `${label} does not match its expected sha256`, { actual, expected });
  }
  return actual;
}

function activityExpectations(source) {
  return {
    expectedActivityGeneration: source.activityGeneration,
    expectedActivityHeadSha256: source.activityExternalHeadSha256,
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

function printTransitionResult(opts, result, fallback) {
  const st = protocolState.status(opts);
  printBoundedResult({
    capabilityGeneration: st.capabilityGeneration,
    capabilityHeadSha256: st.capabilityHeadSha256,
    mode: st.mode,
    activeIdentitySha256: st.activeIdentitySha256,
    operationResult: (result && (result.result || result.operationResult)) || fallback,
  });
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

function runFactoryZero(values) {
  const opts = rootOptionsFrom(values);
  protocolState.requireFactoryBaselinePhase(values['--deployment-state'], {
    expectedBaselineId: values['--expected-baseline-id'],
    expectedPhase: values['--expected-phase'],
    expectedBaselinePrefix: values['--expected-baseline-prefix'],
    expectedParentGeneration: values['--expected-parent-generation'],
    operationId: values['--operation-id'],
  });
  const databaseStat = fs.lstatSync(values['--database']);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) {
    throw cliError('factory_database_invalid', '--database must be a regular nonsymlink file');
  }
  const result = capabilityTransitions.initializeFactoryZero({
    ...opts,
    operationId: values['--operation-id'],
    baselineId: values['--expected-baseline-id'],
    parentGeneration: values['--expected-parent-generation'],
    factoryProvenance: readJsonFile(values['--factory-provenance'], { artifactOwned: true }),
    imageGuardManifest: readJsonFile(values['--image-guard-manifest'], { artifactOwned: true }),
    factorySeedReceipt: readJsonFile(values['--factory-seed-receipt']),
    ackAuditReport: readJsonFile(values['--ack-audit-report']),
    factoryIntentOut: values['--factory-intent-out'],
    factoryZeroSourceReceiptOut: values['--factory-zero-source-receipt-out'],
  });
  printTransitionResult(opts, result, 'FACTORY_ZERO_CLEAR');
}

function runRecordDisposition(values) {
  const opts = rootOptionsFrom(values);
  const audit = readJsonFile(values['--ack-audit-report']);
  const backup = readJsonFile(values['--backup-manifest']);
  const disposition = readJsonFile(values['--disposition-receipt']);
  if (values['--expected-phase'] === 'protocol-dispositioning') {
    protocolState.requireDeploymentPhase(values['--deployment-state'], {
      expectedDeploymentId: values['--expected-deployment-id'],
      expectedPhase: values['--expected-phase'],
      expectedParentGeneration: values['--expected-parent-generation'],
    });
  } else if (values['--expected-phase'] === 'integrity-historical-dispositioning') {
    requireRecovery(values, disposition.recoveryOperationId, 'integrity-historical-dispositioning', disposition.requestId);
  } else {
    throw cliError('record_disposition_phase_invalid', 'record-v2-disposition requires protocol-dispositioning or integrity-historical-dispositioning');
  }
  requireHash(disposition, values['--expected-disposition-receipt-sha256'], 'disposition receipt');
  if (disposition.identitySha256 != null && disposition.identitySha256 !== values['--expected-identity-sha256']) {
    throw cliError('disposition_identity_mismatch', 'disposition receipt identity does not match --expected-identity-sha256');
  }
  const sourceKind = disposition.sourceKind;
  const historicalV2Disposition = disposition.historicalV2Disposition || disposition.result;
  const source = {
    sourceKind,
    ...(sourceKind === 'zero' ? { sourceAuthorityKind: 'deployment-backup' } : {}),
    dispositionReceiptSha256: canonicalSha256(disposition),
    auditSha256: canonicalSha256(audit),
    databaseSha256: audit.databaseIdentitySha256,
    backupSha256: canonicalSha256(backup),
    identitySha256: values['--expected-identity-sha256'],
    historicalV2Disposition,
  };
  for (const [field, actual] of [
    ['auditSha256', source.auditSha256],
    ['databaseSha256', source.databaseSha256],
    ['backupSha256', source.backupSha256],
  ]) {
    if (disposition[field] != null && disposition[field] !== actual) {
      throw cliError('disposition_source_fact_mismatch', `disposition receipt ${field} does not match the supplied evidence`);
    }
  }
  const result = capabilityTransitions.recordHistoricalV2Disposition({
    ...opts,
    operationId: values['--operation-id'],
    expectedHeadSha256: values['--expected-head-sha256'],
    expectedWitnessSha256: values['--expected-witness-sha256'],
    ...activityExpectations(backup),
    source,
  });
  printTransitionResult(opts, result, historicalV2Disposition);
}

function requireRecovery(values, recoveryOperationId, expectedRecoveryPhase, requestId) {
  const state = protocolState.readDeploymentStateFile(values['--deployment-state']);
  return protocolState.requireRecoveryPhase(values['--deployment-state'], {
    expectedDeploymentId: values['--expected-deployment-id'] || state.parentDeployment.deploymentId,
    expectedParentGeneration: values['--expected-parent-generation'] != null
      ? values['--expected-parent-generation']
      : state.parentDeployment.generation,
    recoveryOperationId,
    expectedRecoveryPhase,
    requestId,
  });
}

function runPrepareDispositionRestore(values) {
  const opts = rootOptionsFrom(values);
  requireRecovery(values, values['--recovery-operation-id'], values['--expected-recovery-phase']);
  const audit = readJsonFile(values['--ack-audit-report']);
  const backup = readJsonFile(values['--backup-manifest']);
  const result = capabilityTransitions.prepareDispositionRestore({
    ...opts,
    deploymentId: values['--expected-deployment-id'],
    parentGeneration: values['--expected-parent-generation'],
    recoveryOperationId: values['--recovery-operation-id'],
    auditSha256: canonicalSha256(audit),
    backupManifestSha256: canonicalSha256(backup),
    backupSha256: values['--expected-backup-sha256'],
    identitySha256: values['--expected-identity-sha256'],
    expectedHeadSha256: values['--expected-head-sha256'],
    expectedWitnessSha256: values['--expected-witness-sha256'],
    ...activityExpectations(backup),
    prepareIntentOut: values['--prepare-intent-out'],
    resultOut: values['--result-out'],
  });
  if (result.result === 'REJECTED') {
    throw cliError('disposition_restore_rejected', `disposition restore preparation rejected: ${result.reason}`);
  }
  printTransitionResult(opts, result, result.result);
}

function runInvalidateDisposition(values) {
  const opts = rootOptionsFrom(values);
  requireRecovery(values, values['--recovery-operation-id'], values['--expected-recovery-phase']);
  const preparation = readJsonFile(values['--restore-preparation-result']);
  const restoreReceipt = readJsonFile(values['--restore-receipt']);
  const restoredAudit = readJsonFile(values['--ack-audit-report']);
  const result = capabilityTransitions.invalidateHistoricalV2Disposition({
    ...opts,
    operationId: `${values['--recovery-operation-id']}:disposition-invalidation`,
    recoveryOperationId: values['--recovery-operation-id'],
    restorePreparationResult: preparation,
    restoreReceiptSha256: canonicalSha256(restoreReceipt),
    restoredDatabaseAuditSha256: canonicalSha256(restoredAudit),
    identitySha256: values['--expected-identity-sha256'],
    expectedHeadSha256: values['--expected-head-sha256'],
    expectedWitnessSha256: values['--expected-witness-sha256'],
    ...activityExpectations(preparation),
  });
  printTransitionResult(opts, result, 'RECONCILIATION_REQUIRED');
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writePrivateJson(filePath, value) {
  protocolState.__internal.assertNoSymlinkComponents(filePath);
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, protocolState.canonicalJson(value));
    fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
  const dirFd = fs.openSync(parent, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

function sqliteSnapshotAdapter(sourcePath) {
  return ({ snapshotPath, recoveryOperationId, restoreEpoch, currentCommandAudit, currentFarmingAudit,
    reverseMergeAdapterInventorySha256, createdAt }) => {
    protocolState.__internal.assertNoSymlinkComponents(snapshotPath);
    const manifestPath = snapshotPath.endsWith('.sqlite')
      ? snapshotPath.slice(0, -'.sqlite'.length) + '.json'
      : snapshotPath + '.json';
    if (fs.existsSync(snapshotPath)) {
      const existing = readJsonFile(manifestPath);
      if (
        existing.status !== 'AVAILABLE' || existing.snapshotPath !== snapshotPath ||
        existing.recoveryOperationId !== recoveryOperationId || existing.restoreEpoch !== restoreEpoch ||
        existing.snapshotSizeBytes !== fs.statSync(snapshotPath).size ||
        existing.snapshotSha256 !== fileSha256(snapshotPath)
      ) throw cliError('snapshot_resume_mismatch', 'existing SQLite snapshot does not match the same recovery operation');
      return existing;
    }
    const escaped = snapshotPath.replaceAll("'", "''");
    const child = childProcess.spawnSync('/usr/bin/sqlite3', [sourcePath, `.backup '${escaped}'`], { encoding: 'utf8' });
    if (child.status !== 0) {
      throw cliError('snapshot_backup_failed', 'SQLite online backup failed');
    }
    fs.chmodSync(snapshotPath, 0o600);
    const check = childProcess.spawnSync('/usr/bin/sqlite3', [snapshotPath, 'PRAGMA quick_check;'], { encoding: 'utf8' });
    if (check.status !== 0 || check.stdout.trim() !== 'ok') {
      throw cliError('snapshot_quick_check_failed', 'SQLite snapshot quick_check failed');
    }
    const stat = fs.statSync(snapshotPath);
    const owned = new Set(Array.isArray(currentCommandAudit.commandOwnedTables) ? currentCommandAudit.commandOwnedTables : []);
    const manifest = {
      format: 1,
      status: 'AVAILABLE',
      recoveryOperationId,
      restoreEpoch,
      snapshotPath,
      snapshotSizeBytes: stat.size,
      snapshotSha256: fileSha256(snapshotPath),
      databaseIdentitySha256: currentFarmingAudit.databaseIdentitySha256,
      commandAuditSha256: canonicalSha256(currentCommandAudit),
      farmingAuditSha256: canonicalSha256(currentFarmingAudit),
      reverseMergeAdapterInventorySha256,
      commandOwnedTables: currentFarmingAudit.tables.filter((entry) => owned.has(entry.name)),
      createdAt,
    };
    writePrivateJson(manifestPath, manifest);
    return manifest;
  };
}

function runPrepareDatabaseRestore(values) {
  const opts = rootOptionsFrom(values);
  requireRecovery(values, values['--recovery-operation-id'], values['--expected-recovery-phase']);
  const backupManifest = readJsonFile(values['--backup-manifest']);
  const restoreBaseline = readJsonFile(values['--restore-baseline']);
  const reverseInventory = readJsonFile(values['--reverse-merge-adapter-inventory'], { artifactOwned: true });
  const backupCommandAudit = readJsonFile(values['--backup-command-audit-report']);
  const backupFarmingAudit = readJsonFile(values['--backup-farming-audit-report']);
  const currentCommandAudit = readJsonFile(values['--current-command-audit-report']);
  const currentFarmingAudit = readJsonFile(values['--current-farming-audit-report']);
  const lineageReceipt = readOptionalJson(values['--database-lineage-invalidation-receipt']);
  const result = capabilityTransitions.prepareDatabaseRestore({
    ...opts,
    deploymentId: values['--expected-deployment-id'],
    parentGeneration: values['--expected-parent-generation'],
    recoveryOperationId: values['--recovery-operation-id'],
    backupManifest,
    restoreBaseline,
    reverseMergeAdapterInventory: reverseInventory,
    backupCommandAudit,
    backupFarmingAudit,
    currentCommandAudit,
    currentFarmingAudit,
    currentSnapshot: values['--current-snapshot'],
    databaseLineageInvalidationReceiptSha256: lineageReceipt ? canonicalSha256(lineageReceipt) : null,
    expectedHeadSha256: values['--expected-head-sha256'],
    expectedWitnessSha256: values['--expected-witness-sha256'],
    expectedActivityGeneration: values['--expected-activity-generation'],
    expectedActivityHeadSha256: values['--expected-activity-head-sha256'],
    prepareIntentOut: values['--prepare-intent-out'],
    resultOut: values['--result-out'],
    snapshotAdapter: sqliteSnapshotAdapter(currentFarmingAudit.databasePath),
  });
  if (result.result === 'REJECTED') {
    throw cliError('database_restore_rejected', `database restore preparation rejected: ${result.reason}`);
  }
  printTransitionResult(opts, result, result.result);
}

function runCompleteDatabaseRestore(values) {
  const opts = rootOptionsFrom(values);
  requireRecovery(values, values['--recovery-operation-id'], values['--expected-recovery-phase']);
  const result = capabilityTransitions.completeDatabaseRestoreReconciliation({
    ...opts,
    deploymentId: values['--expected-deployment-id'],
    parentGeneration: values['--expected-parent-generation'],
    recoveryOperationId: values['--recovery-operation-id'],
    prepareResult: readJsonFile(values['--prepare-result']),
    mergeReceipt: readJsonFile(values['--merge-receipt']),
    reverseMergeAdapterInventory: readJsonFile(values['--reverse-merge-adapter-inventory'], { artifactOwned: true }),
    postMergeAuditReport: readJsonFile(values['--post-merge-audit-report']),
    expectedHeadSha256: values['--expected-head-sha256'],
    expectedWitnessSha256: values['--expected-witness-sha256'],
    expectedActivityGeneration: values['--expected-activity-generation'],
    expectedActivityHeadSha256: values['--expected-activity-head-sha256'],
  });
  printTransitionResult(opts, result, 'RECONCILED');
}

function runPrepareIntegrity(values) {
  const opts = rootOptionsFrom(values);
  const recoveryRequest = readJsonFile(values['--recovery-request']);
  const authority = readJsonFile(values['--authority']);
  requireRecovery(values, authority.recoveryOperationId, 'integrity-recovery-preparing', recoveryRequest.requestId);
  const observedEvidence = readJsonFile(path.join(path.dirname(values['--authority']), 'observed-evidence.json'));
  const lineageReceipt = readOptionalJson(values['--database-lineage-invalidation-receipt']);
  const backupManifest = readJsonFile(values['--backup-manifest']);
  const result = capabilityTransitions.prepareIntegrityRecovery({
    ...opts,
    recoveryRequest,
    authority,
    observedEvidence,
    backupManifest,
    databaseLineageInvalidationReceiptSha256: lineageReceipt ? canonicalSha256(lineageReceipt) : null,
    forensicDestination: values['--forensic-destination'],
    resultOut: values['--result-out'],
    expectedHeadSha256: backupManifest.capabilityHeadSha256,
    expectedWitnessSha256: backupManifest.capabilityWitnessSha256,
    expectedActivityGeneration: backupManifest.activityGeneration,
    expectedActivityHeadSha256: backupManifest.activityExternalHeadSha256,
  });
  if (result.result === 'REJECTED' || result.result === 'FORWARD_REPAIR_REQUIRED') {
    throw cliError('integrity_recovery_rejected', `integrity recovery preparation did not authorize replacement: ${result.result}`);
  }
  printTransitionResult(opts, result, result.result);
}

function runCompleteIntegrity(values) {
  const opts = rootOptionsFrom(values);
  const recoveryRequest = readJsonFile(values['--recovery-request']);
  const authority = readJsonFile(values['--reconciliation-authority']);
  requireRecovery(values, authority.recoveryOperationId, 'integrity-reconciliation-required', recoveryRequest.requestId);
  const recoveredRowsManifest = readOptionalJson(values['--recovered-rows-manifest']);
  const offlineImportManifest = readOptionalJson(values['--offline-import-manifest']);
  let offlineImportReceiptSha256 = null;
  if (offlineImportManifest) {
    const importReceipt = readJsonFile(path.join(path.dirname(values['--offline-import-manifest']), 'offline-import-receipt.json'));
    offlineImportReceiptSha256 = canonicalSha256(importReceipt);
  }
  const historicalRevalidationReceipt = readJsonFile(values['--historical-revalidation-receipt']);
  const result = capabilityTransitions.completeIntegrityRecovery({
    ...opts,
    recoveryRequest,
    reconciliationAuthority: authority,
    forensicInventory: readJsonFile(values['--forensic-inventory']),
    cloudComparison: readJsonFile(values['--cloud-comparison']),
    recoveredRowsManifest,
    offlineImportManifest,
    offlineImportReceiptSha256,
    acceptedLossBoundary: readOptionalJson(values['--accepted-loss-boundary']),
    commandCapabilityCutoffProof: readOptionalJson(values['--command-capability-cutoff-proof']),
    historicalRevalidationReceipt,
    postReconcileCommandAudit: readJsonFile(values['--post-reconcile-command-audit']),
    postReconcileFarmingAudit: readJsonFile(values['--post-reconcile-farming-audit']),
    expectedHeadSha256: historicalRevalidationReceipt.currentCapabilityHeadSha256,
    expectedWitnessSha256: historicalRevalidationReceipt.currentCapabilityWitnessSha256,
    expectedActivityGeneration: historicalRevalidationReceipt.activityGeneration,
    expectedActivityHeadSha256: historicalRevalidationReceipt.activityExternalHeadSha256,
    databaseLineageInvalidationReceiptSha256: authority.databaseLineageInvalidationReceiptSha256,
    externalEffectCalls: 0,
    ackTransportCalls: 0,
  });
  printTransitionResult(opts, result, 'RECONCILED');
}

function runAuthorizeReset(values) {
  const opts = rootOptionsFrom(values);
  const confirmation = readJsonFile(values['--confirmation']);
  const result = capabilityTransitions.authorizeReset({
    ...opts,
    confirmation,
    confirmationPath: values['--confirmation'],
    backupManifest: readJsonFile(values['--backup-manifest']),
    ackAuditReport: readJsonFile(values['--ack-audit-report']),
    expectedHeadSha256: confirmation.expectedHeadSha256,
    expectedWitnessSha256: confirmation.expectedWitnessSha256,
  });
  printTransitionResult(opts, result, 'RESET_AUTHORIZED');
}

function run(argv) {
  const verb = argv[0];
  if (!verb) {
    throw cliError('cli_missing_verb', 'usage: sync-protocol-capability-cli.js <verb> [--flag value ...]');
  }
  const rest = argv.slice(1);
  const values = parseVerbArgs(verb, rest);
  const dispatch = {
    'initialize-factory-zero': runFactoryZero,
    initialize: runInitialize,
    status: runStatus,
    'record-v2-disposition': runRecordDisposition,
    'prepare-disposition-restore': runPrepareDispositionRestore,
    'invalidate-v2-disposition': runInvalidateDisposition,
    'prepare-database-restore': runPrepareDatabaseRestore,
    'complete-database-restore-reconciliation': runCompleteDatabaseRestore,
    'prepare-integrity-recovery': runPrepareIntegrity,
    'complete-integrity-recovery': runCompleteIntegrity,
    'authorize-reset': runAuthorizeReset,
  };
  dispatch[verb](values);
}

if (require.main === module) {
  try {
    if (!process.stdin.isTTY) {
      const stdin = fs.readFileSync(0, 'utf8');
      if (stdin.length !== 0) throw cliError('cli_stdin_forbidden', 'stdin input is forbidden');
    }
    run(process.argv.slice(2));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[sync-protocol-capability-cli] ${err.code || 'error'}: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { run, parseVerbArgs, VERB_FLAGS };
